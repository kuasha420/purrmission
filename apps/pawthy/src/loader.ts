import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Returns candidate .env file paths in order from lowest precedence to highest precedence.
 *
 * Cascading precedence (lowest to highest):
 * .env < .env.{environment} < .env.local < .env.{environment}.local
 */
export function getCandidateEnvFiles(rootDir: string, environment?: string): string[] {
  const baseDir = path.resolve(rootDir);
  const candidateNames: string[] = ['.env'];

  if (environment && environment.trim() !== '') {
    const env = environment.trim();
    candidateNames.push(`.env.${env}`);
    candidateNames.push('.env.local');
    candidateNames.push(`.env.${env}.local`);
  } else {
    candidateNames.push('.env.local');
  }

  return candidateNames.map((filename) => path.join(baseDir, filename));
}

/**
 * Loads and merges environment variables from cascading .env files.
 * Missing files (ENOENT) are gracefully skipped.
 * Values from higher precedence files override lower precedence files.
 */
export function loadCascadingEnv(
  options: { rootDir?: string; environment?: string } = {}
): Record<string, string> {
  const rootDir = options.rootDir || process.cwd();
  const files = getCandidateEnvFiles(rootDir, options.environment);
  const result: Record<string, string> = {};

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = dotenv.parse(content);
      Object.assign(result, parsed);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
  }

  return result;
}
