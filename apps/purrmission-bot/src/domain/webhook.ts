import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Validates if an IP address is a public, non-reserved IP.
 */
export function isPublicIP(ip: string): boolean {
  // Allow overriding in test environments if explicitly configured
  if (process.env.ALLOW_PRIVATE_WEBHOOKS === 'true') {
    return true;
  }

  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return false;

    // Loopback (127.0.0.0/8)
    if (parts[0] === 127) return false;
    // Private (RFC 1918)
    if (parts[0] === 10) return false;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    if (parts[0] === 192 && parts[1] === 168) return false;
    // Link-local (169.254.0.0/16)
    if (parts[0] === 169 && parts[1] === 254) return false;
    // Unspecified / Broadcast (0.0.0.0, 255.255.255.255)
    if (parts[0] === 0 || parts[0] === 255) return false;
    // Carrier-Grade NAT (100.64.0.0/10)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false;
    // Multicast (224.0.0.0/4)
    if (parts[0] >= 224 && parts[0] <= 239) return false;
    // Reserved / Future use (240.0.0.0/4)
    if (parts[0] >= 240) return false;

    return true;
  }

  if (isIP(ip) === 6) {
    const normalized = ip.toLowerCase().trim();
    // Loopback (::1)
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return false;
    // Unspecified (::)
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return false;
    // Link-local (fe80::/10)
    if (
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fe90:') ||
      normalized.startsWith('fea0:') ||
      normalized.startsWith('feb0:')
    )
      return false;
    // Unique local address (fc00::/7)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    // Multicast (ff00::/8)
    if (normalized.startsWith('ff')) return false;
    // IPv4-mapped IPv6 address (::ffff:192.0.2.128 or similar)
    if (normalized.startsWith('::ffff:')) {
      const v4Part = normalized.substring(7);
      if (isIP(v4Part) === 4) {
        return isPublicIP(v4Part);
      }
      return false;
    }

    return true;
  }

  return false;
}

export interface WebhookPayload {
  eventType: string;
  requestId: string;
  resourceId: string;
  status: string;
  targetVersion: string;
  timestamp: string;
  nonce: string;
}

export interface WebhookResponse {
  statusCode: number;
  body: string;
}

/**
 * SSRF-Safe Webhook Client that performs DNS pinning and screens IP ranges.
 */
export class SSRFSafeWebhookClient {
  /**
   * Dispatches a signed, value-free JSON webhook payload to a URL.
   */
  static async send(
    urlStr: string,
    secret: string,
    payload: Omit<WebhookPayload, 'timestamp' | 'nonce'>
  ): Promise<WebhookResponse> {
    const urlObject = new URL(urlStr);

    // Enforce scheme validation: only HTTPS is allowed (HTTP allowed only in test environment)
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.ALLOW_PRIVATE_WEBHOOKS === 'true';
    if (urlObject.protocol !== 'https:' && !(isTestEnv && urlObject.protocol === 'http:')) {
      throw new Error(`Forbidden protocol: "${urlObject.protocol}". Only HTTPS is allowed.`);
    }

    // Port check: standard HTTP/HTTPS ports only
    const port = urlObject.port
      ? Number(urlObject.port)
      : urlObject.protocol === 'https:'
        ? 443
        : 80;
    if (port !== 443 && port !== 80 && !isTestEnv) {
      throw new Error(`Forbidden outbound port: ${port}.`);
    }

    // 1. Resolve DNS hostname to IP addresses
    let ips: string[] = [];
    if (isIP(urlObject.hostname)) {
      ips = [urlObject.hostname];
    } else {
      const lookupResult = await dns.lookup(urlObject.hostname, { all: true }).catch(() => []);
      ips = lookupResult.map((entry) => entry.address);
    }

    if (ips.length === 0) {
      throw new Error(`DNS resolution failed for hostname: "${urlObject.hostname}"`);
    }

    // 2. Reject mixed/private answers
    for (const ip of ips) {
      if (!isPublicIP(ip)) {
        throw new Error(`SSRF Block: Connection to private IP address is forbidden: ${ip}`);
      }
    }

    // 3. Pin connection to the first validated IP address
    const pinnedIp = ips[0];

    // 4. Construct replay-resistant, value-free envelope
    const envelope: WebhookPayload = {
      ...payload,
      timestamp: new Date().toISOString(),
      nonce: crypto.randomUUID(),
    };

    const requestBody = JSON.stringify(envelope);

    // 5. Generate HMAC-SHA256 signature
    const signature = crypto.createHmac('sha256', secret).update(requestBody).digest('hex');

    // 6. Spawn outbound request
    const requestOptions: https.RequestOptions = {
      hostname: pinnedIp,
      port,
      path: urlObject.pathname + urlObject.search,
      method: 'POST',
      headers: {
        Host: urlObject.hostname,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'X-Purrmission-Signature': `sha256=${signature}`,
      },
      // Servername MUST match original hostname for TLS handshake/validation
      servername: urlObject.hostname,
      timeout: 10000, // Strict timeout: 10 seconds
    };

    return new Promise((resolve, reject) => {
      const reqLib = urlObject.protocol === 'https:' ? https : http;
      const req = reqLib.request(requestOptions, (res) => {
        // SSRF defense: reject redirects to avoid loopback bypasses
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          req.destroy();
          return reject(
            new Error(`SSRF Block: HTTP redirects are forbidden (status: ${res.statusCode})`)
          );
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // Enforce response size limits to prevent denial-of-service
          if (Buffer.byteLength(body) > 1048576) {
            // Max 1MB
            req.destroy();
            reject(new Error('Response size limit exceeded (max 1MB).'));
          }
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 500,
            body,
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timed out.'));
      });

      req.write(requestBody);
      req.end();
    });
  }
}
