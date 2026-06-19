import * as https from 'https';

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Minimal HTTPS request helper using Node.js built-ins.
 * Throws on network errors and non-2xx status codes.
 */
export function httpRequest(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    };

    const req = https.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode} from ${url}: ${body.slice(0, 200)}`));
          return;
        }
        resolve({
          statusCode,
          body,
          headers: res.headers as Record<string, string | string[] | undefined>,
        });
      });
    });

    req.on('error', reject);

    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy();
        reject(new Error(`Request to ${url} timed out after ${options.timeoutMs}ms`));
      });
    }

    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Fetch and parse JSON in one call. */
export async function httpGetJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const res = await httpRequest(url, options);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`Failed to parse JSON from ${url}: ${res.body.slice(0, 100)}`);
  }
}
