import path from 'path';
import YAML from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import dotenv from 'dotenv';

export type SecretFormat = 'env' | 'json' | 'yaml' | 'toml';

export interface ResolvedFileAndFormat {
  file: string;
  format: SecretFormat;
}

export function getDefaultFilename(format: SecretFormat): string {
  switch (format) {
    case 'json':
      return 'secrets.json';
    case 'yaml':
      return 'secrets.yaml';
    case 'toml':
      return 'secrets.toml';
    case 'env':
    default:
      return '.env';
  }
}

export function resolveFileAndFormat(
  fileOption?: string,
  formatOption?: string
): ResolvedFileAndFormat {
  let format: SecretFormat | null = null;

  if (formatOption !== undefined && formatOption !== null && formatOption.trim() !== '') {
    const norm = formatOption.trim().toLowerCase();
    if (norm === 'yml') {
      format = 'yaml';
    } else if (norm === 'env' || norm === 'json' || norm === 'yaml' || norm === 'toml') {
      format = norm as SecretFormat;
    } else {
      throw new Error(
        `Unsupported format '${formatOption}'. Supported formats are: env, json, yaml, toml.`
      );
    }
  }

  if (format) {
    const file = fileOption || getDefaultFilename(format);
    return { file, format };
  }

  if (fileOption) {
    const basename = path.basename(fileOption);
    const ext = path.extname(fileOption).toLowerCase();

    if (basename === '.env' || basename.startsWith('.env.') || ext === '.env') {
      format = 'env';
    } else if (ext === '.json') {
      format = 'json';
    } else if (ext === '.yaml' || ext === '.yml') {
      format = 'yaml';
    } else if (ext === '.toml') {
      format = 'toml';
    } else {
      throw new Error(
        `Could not auto-detect file format for '${fileOption}'. Please specify --format <env|json|yaml|toml>.`
      );
    }
    return { file: fileOption, format };
  }

  return { file: '.env', format: 'env' };
}

export function flattenSecrets(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenSecrets(value as Record<string, unknown>, fullKey));
    } else if (value === null || value === undefined) {
      result[fullKey] = '';
    } else {
      result[fullKey] = String(value);
    }
  }
  return result;
}

export function deserializeSecrets(
  content: string,
  format: SecretFormat,
  filePath: string
): Record<string, string> {
  if (format === 'env') {
    const parsed = dotenv.parse(content);
    for (const key of Object.keys(parsed)) {
      parsed[key] = parsed[key].replace(/\\"/g, '"');
    }
    return parsed;
  }

  if (content.trim() === '') {
    return {};
  }

  let parsed: unknown;
  try {
    if (format === 'json') {
      parsed = JSON.parse(content);
    } else if (format === 'yaml') {
      parsed = YAML.parse(content);
    } else if (format === 'toml') {
      parsed = parseToml(content);
    }
  } catch (e: unknown) {
    const formatUpper = format.toUpperCase();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not parse ${formatUpper} file at ${filePath}: ${msg}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid content in ${filePath}. Top-level structure must be a key-value object.`
    );
  }

  return flattenSecrets(parsed as Record<string, unknown>);
}

interface EnvBlock {
  type: 'comment' | 'empty' | 'key-value';
  raw: string;
  key?: string;
  value?: string;
  leadingWhitespace?: string;
  middleWhitespace?: string;
  quote?: '"' | "'" | null;
  comment?: string;
}

function parseEnv(content: string, eol: string = '\n'): EnvBlock[] {
  const lines = content.split('\n');
  const blocks: EnvBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }

    if (/^\s*#/.test(line) || /^\s*$/.test(line)) {
      blocks.push({
        type: /^\s*#/.test(line) ? 'comment' : 'empty',
        raw: line,
      });
      i++;
      continue;
    }

    const declMatch = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!declMatch) {
      blocks.push({
        type: 'comment',
        raw: line,
      });
      i++;
      continue;
    }

    const leadingWhitespace = declMatch[1];
    const key = declMatch[2];
    const rest = declMatch[3];

    const prefixLength = leadingWhitespace.length + key.length;
    const middleWhitespaceMatch = line.slice(prefixLength).match(/^\s*=\s*/);
    const middleWhitespace = middleWhitespaceMatch ? middleWhitespaceMatch[0] : '=';

    let value = '';
    let quote: '"' | "'" | null = null;
    let trailingComment = '';
    const rawBlockLines = [line];

    if (rest.startsWith('"')) {
      quote = '"';
      const restValue = rest.slice(1);
      let currentLineIndex = i;
      let foundEnd = false;
      let valAcc = '';

      while (currentLineIndex < lines.length) {
        let curLine = currentLineIndex === i ? restValue : lines[currentLineIndex];
        if (curLine.endsWith('\r')) {
          curLine = curLine.slice(0, -1);
        }
        let escaped = false;
        let quoteIndex = -1;
        for (let charIdx = 0; charIdx < curLine.length; charIdx++) {
          const char = curLine[charIdx];
          if (char === '\\') {
            escaped = !escaped;
          } else if (char === '"' && !escaped) {
            quoteIndex = charIdx;
            break;
          } else {
            escaped = false;
          }
        }

        if (quoteIndex !== -1) {
          valAcc += curLine.slice(0, quoteIndex);
          trailingComment = curLine.slice(quoteIndex + 1);
          foundEnd = true;
          break;
        } else {
          valAcc += curLine + '\n';
          if (currentLineIndex > i) {
            rawBlockLines.push(lines[currentLineIndex]);
          }
          currentLineIndex++;
        }
      }

      if (foundEnd) {
        value = valAcc;
        i = currentLineIndex + 1;
      } else {
        quote = null;
        value = rest;
        i++;
      }
    } else if (rest.startsWith("'")) {
      quote = "'";
      const restValue = rest.slice(1);
      let currentLineIndex = i;
      let foundEnd = false;
      let valAcc = '';

      while (currentLineIndex < lines.length) {
        let curLine = currentLineIndex === i ? restValue : lines[currentLineIndex];
        if (curLine.endsWith('\r')) {
          curLine = curLine.slice(0, -1);
        }
        let escaped = false;
        let quoteIndex = -1;
        for (let charIdx = 0; charIdx < curLine.length; charIdx++) {
          const char = curLine[charIdx];
          if (char === '\\') {
            escaped = !escaped;
          } else if (char === "'" && !escaped) {
            quoteIndex = charIdx;
            break;
          } else {
            escaped = false;
          }
        }

        if (quoteIndex !== -1) {
          valAcc += curLine.slice(0, quoteIndex);
          trailingComment = curLine.slice(quoteIndex + 1);
          foundEnd = true;
          break;
        } else {
          valAcc += curLine + '\n';
          if (currentLineIndex > i) {
            rawBlockLines.push(lines[currentLineIndex]);
          }
          currentLineIndex++;
        }
      }

      if (foundEnd) {
        value = valAcc;
        i = currentLineIndex + 1;
      } else {
        quote = null;
        value = rest;
        i++;
      }
    } else {
      const commentMatch = rest.match(/(\s+#.*)$/);
      if (commentMatch) {
        value = rest.slice(0, rest.length - commentMatch[1].length).trim();
        trailingComment = commentMatch[1];
      } else {
        value = rest.trim();
        trailingComment = '';
      }
      quote = null;
      i++;
    }

    blocks.push({
      type: 'key-value',
      raw: rawBlockLines.join(eol),
      key,
      value,
      leadingWhitespace,
      middleWhitespace,
      quote,
      comment: trailingComment,
    });
  }
  return blocks;
}

export function formatEnvValue(value: string, originalQuote?: '"' | "'" | null): string {
  // If value has double quotes but no single quotes, wrap in single quotes for clean dotenv.parse roundtrip
  if (
    value.includes('"') &&
    !value.includes("'") &&
    !value.includes('\n') &&
    !value.includes('\r')
  ) {
    return `'${value}'`;
  }

  // If value has single quotes but no double quotes, wrap in double quotes
  if (
    value.includes("'") &&
    !value.includes('"') &&
    !value.includes('\n') &&
    !value.includes('\r')
  ) {
    return `"${value}"`;
  }

  // If originalQuote is valid and safe, use it
  if (originalQuote === "'" && !value.includes("'")) {
    return `'${value}'`;
  }
  if (originalQuote === '"' && !value.includes('"')) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  if (/[#=\s'"]/.test(value) || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return value;
}

export function mergeEnvSecrets(existingContent: string, secrets: Record<string, string>): string {
  const eol = existingContent.includes('\r\n') ? '\r\n' : '\n';
  const blocks = parseEnv(existingContent, eol);
  const updatedKeys = new Set<string>();
  const resultLines: string[] = [];

  for (const block of blocks) {
    if (block.type === 'key-value' && block.key) {
      const key = block.key;
      if (Object.prototype.hasOwnProperty.call(secrets, key)) {
        const value = secrets[key];
        resultLines.push(
          block.leadingWhitespace +
            key +
            block.middleWhitespace +
            formatEnvValue(value, block.quote) +
            block.comment
        );
        updatedKeys.add(key);
        continue;
      }
    }
    resultLines.push(block.raw);
  }

  const newKeys = Object.keys(secrets).filter((k) => !updatedKeys.has(k));
  if (newKeys.length > 0) {
    if (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() !== '') {
      resultLines.push('');
    }
    for (const key of newKeys) {
      const value = secrets[key];
      resultLines.push(key + '=' + formatEnvValue(value));
    }
  }

  return resultLines.join(eol);
}

export function serializeSecrets(
  secrets: Record<string, string>,
  format: SecretFormat,
  existingContent?: string
): string {
  if (format === 'env') {
    if (existingContent !== undefined) {
      return mergeEnvSecrets(existingContent, secrets);
    }
    return (
      Object.entries(secrets)
        .map(([key, value]) => `${key}=${formatEnvValue(value)}`)
        .join('\n') + '\n'
    );
  }

  let mergedSecrets: Record<string, unknown> = { ...secrets };
  if (existingContent !== undefined && existingContent.trim() !== '') {
    try {
      let existingObj: unknown = null;
      if (format === 'json') {
        existingObj = JSON.parse(existingContent);
      } else if (format === 'yaml') {
        existingObj = YAML.parse(existingContent);
      } else if (format === 'toml') {
        existingObj = parseToml(existingContent);
      }

      if (existingObj !== null && typeof existingObj === 'object' && !Array.isArray(existingObj)) {
        mergedSecrets = { ...(existingObj as Record<string, unknown>), ...secrets };
      }
    } catch {
      // If existing content fails parsing during merge, overwrite with new secrets
      mergedSecrets = { ...secrets };
    }
  }

  if (format === 'json') {
    return JSON.stringify(mergedSecrets, null, 2) + '\n';
  } else if (format === 'yaml') {
    return YAML.stringify(mergedSecrets);
  } else if (format === 'toml') {
    return stringifyToml(mergedSecrets);
  }

  throw new Error(`Unsupported format '${format}'`);
}
