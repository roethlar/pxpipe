/** Pure routing helpers for the local Codex and Grok subscription namespaces. */

export type SubscriptionVendor = 'codex' | 'grok';

export type ReservedRouteClassification =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'method_not_allowed'; readonly allow: string }
  | {
      readonly kind: 'route';
      readonly vendor: SubscriptionVendor;
      readonly upstreamPath: string;
      readonly hasBody: boolean;
    };

export type SubscriptionBaseResolution =
  | { readonly ok: true; readonly base: string }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

export type SerializedQuerySuffixResult =
  | { readonly ok: true; readonly suffix: string }
  | { readonly ok: false };

interface ReservedRouteSpec {
  readonly pathname: string;
  readonly method: 'GET' | 'POST';
  readonly vendor: SubscriptionVendor;
  readonly upstreamPath: string;
  readonly hasBody: boolean;
}

const RESERVED_PREFIX = '/_pxpipe';

const EXACT_ROUTES: readonly ReservedRouteSpec[] = [
  {
    pathname: '/_pxpipe/codex/responses',
    method: 'POST',
    vendor: 'codex',
    upstreamPath: '/responses',
    hasBody: true,
  },
  {
    pathname: '/_pxpipe/codex/responses/compact',
    method: 'POST',
    vendor: 'codex',
    upstreamPath: '/responses/compact',
    hasBody: true,
  },
  {
    pathname: '/_pxpipe/codex/models',
    method: 'GET',
    vendor: 'codex',
    upstreamPath: '/models',
    hasBody: false,
  },
  {
    pathname: '/_pxpipe/grok/v1/responses',
    method: 'POST',
    vendor: 'grok',
    upstreamPath: '/v1/responses',
    hasBody: true,
  },
  {
    pathname: '/_pxpipe/grok/v1/models',
    method: 'GET',
    vendor: 'grok',
    upstreamPath: '/v1/models',
    hasBody: false,
  },
  {
    pathname: '/_pxpipe/grok/v1/models-v2',
    method: 'GET',
    vendor: 'grok',
    upstreamPath: '/v1/models-v2',
    hasBody: false,
  },
  {
    pathname: '/_pxpipe/grok/v1/settings',
    method: 'GET',
    vendor: 'grok',
    upstreamPath: '/v1/settings',
    hasBody: false,
  },
  {
    pathname: '/_pxpipe/grok/v1/login-config',
    method: 'GET',
    vendor: 'grok',
    upstreamPath: '/v1/login-config',
    hasBody: false,
  },
  {
    pathname: '/_pxpipe/grok/v1/subagents/bundle',
    method: 'GET',
    vendor: 'grok',
    upstreamPath: '/v1/subagents/bundle',
    hasBody: false,
  },
];

const MODEL_DESCENDANTS: readonly {
  readonly localPrefix: string;
  readonly upstreamPrefix: string;
  readonly vendor: SubscriptionVendor;
}[] = [
  {
    localPrefix: '/_pxpipe/codex/models/',
    upstreamPrefix: '/models/',
    vendor: 'codex',
  },
  {
    localPrefix: '/_pxpipe/grok/v1/models/',
    upstreamPrefix: '/v1/models/',
    vendor: 'grok',
  },
];

/**
 * Classify an already separated pathname. Any pathname that merely resembles
 * the reserved namespace is invalid rather than eligible for generic routing.
 */
export function classifyReservedRoute(
  pathname: string,
  method: string,
): ReservedRouteClassification {
  if (!pathname.startsWith(RESERVED_PREFIX)) return { kind: 'none' };
  if (!isSafeSerializedPath(pathname, false, true)) return { kind: 'invalid' };

  let route = EXACT_ROUTES.find((candidate) => candidate.pathname === pathname);

  if (route === undefined) {
    for (const descendant of MODEL_DESCENDANTS) {
      if (!pathname.startsWith(descendant.localPrefix)) continue;

      const suffix = pathname.slice(descendant.localPrefix.length);
      if (suffix.length === 0) return { kind: 'invalid' };
      route = {
        pathname,
        method: 'GET',
        vendor: descendant.vendor,
        upstreamPath: `${descendant.upstreamPrefix}${suffix}`,
        hasBody: false,
      };
      break;
    }
  }

  if (route === undefined) return { kind: 'invalid' };
  if (method.toUpperCase() !== route.method) {
    return { kind: 'method_not_allowed', allow: route.method };
  }

  return {
    kind: 'route',
    vendor: route.vendor,
    upstreamPath: route.upstreamPath,
    hasBody: route.hasBody,
  };
}

/**
 * Validate and normalize an optional subscription base. The returned base has
 * no trailing slash so callers can append a tabled upstream path without URL
 * resolution erasing a fixed base-path prefix.
 */
export function resolveSubscriptionBase(
  value: string | null | undefined,
): SubscriptionBaseResolution {
  if (value === undefined || value === null || value.trim().length === 0) {
    return { ok: false, reason: 'missing' };
  }

  const serialized = value.trim();
  if (!/^https:\/\//i.test(serialized)) return { ok: false, reason: 'invalid' };
  if (/[\\?#\u0000-\u0020\u007f]/u.test(serialized)) {
    return { ok: false, reason: 'invalid' };
  }

  const authorityStart = serialized.indexOf('://') + 3;
  const pathStart = serialized.indexOf('/', authorityStart);
  const rawAuthority = serialized.slice(
    authorityStart,
    pathStart === -1 ? serialized.length : pathStart,
  );
  const rawPath = pathStart === -1 ? '' : serialized.slice(pathStart);

  if (rawAuthority.length === 0) return { ok: false, reason: 'invalid' };
  if (rawPath.length > 0 && !isSafeSerializedPath(rawPath, true, false)) {
    return { ok: false, reason: 'invalid' };
  }

  let parsed: URL;
  try {
    parsed = new URL(serialized);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const normalizedPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
  return { ok: true, base: `${parsed.origin}${normalizedPath}` };
}

/** Return the exact query suffix, including a bare trailing question mark. */
export function serializedQuerySuffix(serializedUrl: string): SerializedQuerySuffixResult {
  if (serializedUrl.includes('#')) return { ok: false };
  const queryStart = serializedUrl.indexOf('?');
  return {
    ok: true,
    suffix: queryStart === -1 ? '' : serializedUrl.slice(queryStart),
  };
}

function isSafeSerializedPath(
  path: string,
  allowTrailingSlash: boolean,
  rejectDuplicateReservedSegment: boolean,
): boolean {
  if (!path.startsWith('/') || /[\\?#\u0000-\u0020\u007f]/u.test(path)) return false;

  const segments = path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) return false;
    if (segment.length === 0) {
      const isAllowedTrailingSlash =
        allowTrailingSlash && index === segments.length - 1 && segments.length === 2;
      const isAllowedNonRootTrailingSlash =
        allowTrailingSlash && index === segments.length - 1 && segments[index - 1]?.length !== 0;
      if (!isAllowedTrailingSlash && !isAllowedNonRootTrailingSlash) return false;
      continue;
    }

    if (!hasValidSafeEscapes(segment)) return false;

    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }

    if (decoded === '.' || decoded === '..') return false;
    if (rejectDuplicateReservedSegment && index > 1 && decoded === '_pxpipe') return false;
  }

  return true;
}

function hasValidSafeEscapes(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;

    const escape = value.slice(index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/iu.test(escape)) return false;

    const octet = Number.parseInt(escape, 16);
    if (octet === 0x2f || octet === 0x5c || octet === 0x25) return false;
    index += 2;
  }
  return true;
}
