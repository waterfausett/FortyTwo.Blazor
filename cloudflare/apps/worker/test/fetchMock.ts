// Mocks the Worker's outbound fetches (Auth0, Expo push). @cloudflare/vitest-pool-workers used to
// export an undici MockAgent as `fetchMock` from 'cloudflare:test'; its successor,
// @cloudflare/vitest-plugin, dropped it, so this keeps the subset of its API the tests use, on a
// stubbed globalThis.fetch. Tests, the Worker and its Durable Objects share one isolate, so the stub
// sees all of their requests.

type Matcher<T> = T | RegExp | ((value: T) => boolean);

interface InterceptOptions {
  /** The path with its query string, as undici matched it. */
  path: Matcher<string>;
  method?: string;
}

interface ReplyOptions {
  headers?: Record<string, string>;
}

/** What a reply callback gets: the request's path (with query string), method and body. */
interface InterceptedRequest {
  path: string;
  method: string;
  body: string;
}

interface CallbackReply {
  statusCode: number;
  data?: string;
  responseOptions?: ReplyOptions;
}

type Responder = (request: InterceptedRequest) => CallbackReply | Promise<CallbackReply>;

interface Interceptor {
  origin: string;
  path: Matcher<string>;
  method: string;
  respond: Responder;
  persist: boolean;
  used: boolean;
}

const interceptors: Interceptor[] = [];
let netConnect = true;
let realFetch: typeof fetch | undefined;

function matches(matcher: Matcher<string>, value: string): boolean {
  if (typeof matcher === 'string') return matcher === value;
  if (matcher instanceof RegExp) return matcher.test(value);
  return matcher(value);
}

async function mockedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = url.pathname + url.search;
  const method = request.method.toUpperCase();
  const interceptor = interceptors.find(
    (i) => (i.persist || !i.used) && i.origin === url.origin && i.method === method && matches(i.path, path),
  );
  if (!interceptor) {
    if (netConnect) return realFetch!(request);
    throw Object.assign(new Error(`fetchMock: no interceptor for ${method} ${url.origin}${path}`), {
      code: 'UND_MOCK_ERR_MOCK_NOT_MATCHED',
    });
  }
  interceptor.used = true;
  const reply = await interceptor.respond({ path, method, body: await request.text() });
  return new Response(reply.data ?? null, { status: reply.statusCode, headers: reply.responseOptions?.headers });
}

export const fetchMock = {
  /** Routes fetch through the interceptors, dropping any left from an earlier file's activate(). */
  activate(): void {
    interceptors.length = 0;
    netConnect = true;
    realFetch ??= globalThis.fetch;
    globalThis.fetch = mockedFetch as typeof fetch;
  },

  /** Makes a request no interceptor matches throw instead of going out to the network. */
  disableNetConnect(): void {
    netConnect = false;
  },

  get(origin: string) {
    return {
      intercept({ path, method = 'GET' }: InterceptOptions) {
        const add = (respond: Responder) => {
          const interceptor: Interceptor = { origin, path, method: method.toUpperCase(), respond, persist: false, used: false };
          interceptors.push(interceptor);
          return {
            /** Keeps answering every matching request, not just the first. */
            persist() {
              interceptor.persist = true;
            },
          };
        };
        return {
          reply(statusOrCallback: number | Responder, data?: string, responseOptions?: ReplyOptions) {
            return add(
              typeof statusOrCallback === 'number'
                ? () => ({ statusCode: statusOrCallback, data, responseOptions })
                : statusOrCallback,
            );
          },
        };
      },
    };
  },

  /** Throws if a one-off interceptor never got its request. */
  assertNoPendingInterceptors(): void {
    const pending = interceptors.filter((i) => !i.persist && !i.used);
    if (pending.length > 0) {
      throw new Error(`fetchMock: ${pending.length} interceptor(s) never called: ${pending.map((i) => `${i.method} ${i.origin}`).join(', ')}`);
    }
  },
};
