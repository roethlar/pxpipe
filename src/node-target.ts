/**
 * Validate raw node:http request targets that could enter pxpipe's reserved
 * subscription namespace. This must run before any WHATWG URL construction,
 * because URL parsing normalizes dot segments and literal backslashes.
 */

export type RawRequestTargetValidation =
  | { readonly ok: true }
  | { readonly ok: false };

const VALID = { ok: true } as const;
const INVALID = { ok: false } as const;

/**
 * Leave unrelated targets alone. For anything that names `_pxpipe` as a path
 * segment (including through a backslash), require one exact leading reserved
 * segment and a serialization that URL parsing cannot reinterpret.
 *
 * The query is deliberately opaque. Only a literal fragment marker is rejected
 * across the complete target; every other query byte is preserved for the core
 * reserved router.
 */
export function validateRawRequestTarget(
  raw: string | undefined,
): RawRequestTargetValidation {
  if (raw === undefined) return VALID;

  const queryStart = raw.indexOf('?');
  const rawPath = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const candidatePath = isolateRequestPath(rawPath);
  const reservedLooking = candidatePath.startsWith('/_pxpipe')
    || /[\\/]_pxpipe(?:[\\/]|$)/u.test(candidatePath)
    || normalizesToReservedLookingPath(candidatePath);
  if (!reservedLooking) return VALID;

  if (
    !rawPath.startsWith('/')
    || rawPath.startsWith('//')
    || raw.includes('#')
    || /[\\\u0000-\u0020\u007f]/u.test(rawPath)
  ) {
    return INVALID;
  }

  const segments = rawPath.split('/');
  if (segments[1] !== '_pxpipe') return INVALID;

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment.length === 0) return INVALID;

    for (let offset = 0; offset < segment.length; offset += 1) {
      if (segment[offset] !== '%') continue;

      const escape = segment.slice(offset + 1, offset + 3);
      if (!/^[0-9a-f]{2}$/iu.test(escape)) return INVALID;

      const octet = Number.parseInt(escape, 16);
      if (octet === 0x2f || octet === 0x5c || octet === 0x25) return INVALID;
      offset += 2;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return INVALID;
    }

    if (decoded === '.' || decoded === '..') return INVALID;
    if (index > 1 && decoded === '_pxpipe') return INVALID;
  }

  return VALID;
}

/** Exclude an absolute-form authority before looking for reserved path text. */
function isolateRequestPath(rawTarget: string): string {
  const sameSchemeRelative = /^http:(?!\/\/)/iu.exec(rawTarget);
  if (sameSchemeRelative) {
    const relative = rawTarget.slice(sameSchemeRelative[0].length);
    return relative.startsWith('/') ? relative : `/${relative}`;
  }

  let authorityStart: number | undefined;
  if (rawTarget.startsWith('//')) {
    authorityStart = 2;
  } else {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(rawTarget);
    if (absolute) authorityStart = absolute[0].length;
  }
  if (authorityStart === undefined) return rawTarget;

  const remainder = rawTarget.slice(authorityStart);
  const pathOffset = remainder.search(/[\\/]/u);
  return pathOffset === -1 ? '' : remainder.slice(pathOffset);
}

/** Model only the path rewrites WHATWG applies before route classification. */
function normalizesToReservedLookingPath(rawPath: string): boolean {
  if (!rawPath.startsWith('/')) return false;

  const stack: string[] = [];
  for (const segment of rawPath.replace(/\\/gu, '/').split('/').slice(1)) {
    const lower = segment.toLowerCase();
    if (lower === '.' || lower === '%2e') continue;
    if (
      lower === '..'
      || lower === '.%2e'
      || lower === '%2e.'
      || lower === '%2e%2e'
    ) {
      stack.pop();
      continue;
    }
    if (segment.length > 0) stack.push(segment);
  }
  return stack[0]?.startsWith('_pxpipe') ?? false;
}
