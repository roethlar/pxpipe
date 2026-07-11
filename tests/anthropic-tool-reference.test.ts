import { describe, expect, it } from 'vitest';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import {
  TOOL_REFERENCE_MANIFEST_TAG,
  makeToolReferenceBoundary,
  toolReferenceBoundaryRef,
  buildAnthropicCandidate as transformRequest,
} from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest, TextBlock, ToolDef } from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
} from './fixtures/anthropic-context.js';

function encode(req: MessagesRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(req));
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(new TextDecoder().decode(body)) as MessagesRequest;
}

function largeTools(marker = 'tool-reference'): ToolDef[] {
  return [{
    name: 'SyntheticShell',
    description: Array.from(
      { length: 2600 },
      (_, index) => `${marker} descriptive row ${index}: synthetic command documentation.`,
    ).join('\n'),
    input_schema: {
      type: 'object',
      title: 'Synthetic shell input',
      description: 'Top-level annotation moves to the reference pages.',
      properties: {
        command: {
          type: 'string',
          description: 'Synthetic command text.',
          minLength: 1,
        },
        mode: {
          type: 'string',
          enum: ['safe', 'inspect'],
          description: 'Synthetic execution mode.',
          default: 'safe',
        },
        description: {
          type: 'string',
          description: 'A parameter whose name collides with a schema annotation.',
        },
      },
      required: ['command'],
      dependentRequired: { description: ['mode'] },
      additionalProperties: false,
    },
  }];
}

function largeProject(marker: string): string {
  return DIRECT_PROJECT_GUIDANCE + '\n' + Array.from(
    { length: 2600 },
    (_, index) => `${marker} project row ${index}: keep project provenance stable.`,
  ).join('\n');
}

function toolManifest(req: MessagesRequest): string {
  return (Array.isArray(req.system) ? req.system : [])
    .find(
      (block): block is TextBlock =>
        block.type === 'text' &&
        block.text.includes(`<${TOOL_REFERENCE_MANIFEST_TAG} version="1">`),
    )?.text ?? '';
}

function toolContract(
  req: MessagesRequest,
  ref: string,
  count: number,
): { images: ContentBlock[]; boundary: TextBlock; manifest: string } {
  const firstUser = req.messages.find((message) => message.role === 'user');
  if (!firstUser || !Array.isArray(firstUser.content)) throw new Error('expected user blocks');
  const boundaryIndex = firstUser.content.findIndex(
    (block) => block.type === 'text' && toolReferenceBoundaryRef(block.text) === ref,
  );
  expect(boundaryIndex).toBeGreaterThanOrEqual(count);
  const boundary = firstUser.content[boundaryIndex] as TextBlock;
  return {
    images: firstUser.content.slice(boundaryIndex - count, boundaryIndex),
    boundary,
    manifest: toolManifest(req),
  };
}

describe('experimental Anthropic tool-reference bucket', () => {
  it('keeps tools native by default', async () => {
    const req: MessagesRequest = {
      model: 'claude-fable-5',
      system: [{ type: 'text', text: 'native system' }],
      tools: largeTools('native-default'),
      messages: [{ role: 'user', content: 'Inspect only.' }],
    };
    const input = encode(req);
    const transformed = await transformRequest(input);

    expect(transformed.body).toBe(input);
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.toolMode).toBe('native');
    expect(transformed.info.toolDisposition).toBe('native_default');
    expect(decode(transformed.body)).toEqual(req);
  });

  it('renders a separately bound reference and installs stubs only after its gate passes', async () => {
    const req: MessagesRequest = {
      model: 'claude-fable-5',
      system: [{ type: 'text', text: 'native base system' }],
      tools: largeTools(),
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Inspect only.', cache_control: { type: 'ephemeral' } }],
      }],
    };
    const input = encode(req);
    const markerCount = countCacheControlMarkers(input);
    const transformed = await transformRequest(input, {
      compressTools: true,
      minCompressChars: 100,
      charsPerToken: 1,
    });
    const out = decode(transformed.body);

    expect(transformed.info.toolMode).toBe('experimental_image');
    expect(transformed.info.toolDisposition).toBe('imaged');
    expect(transformed.info.toolRef).toMatch(/^tr_[0-9a-f]{32}$/);
    expect(transformed.info.toolImageCount).toBeGreaterThan(0);
    expect(transformed.info.toolSourceChars).toBeGreaterThan(100_000);
    expect(transformed.info.toolSourceChars).toBe(JSON.stringify(req.tools).length);
    expect(transformed.info.toolSourceSha8).toMatch(/^[0-9a-f]{8}$/);
    expect(transformed.info.toolGateEval?.profitable).toBe(true);
    expect(transformed.info.imagedBucketChars).toEqual({
      tool_reference: transformed.info.toolDocsChars,
    });
    expect(transformed.info.compressedChars).toBe(transformed.info.toolDocsChars);
    expect(transformed.info.origChars).toBe(transformed.info.toolDocsChars);
    expect(transformed.info.imageCount).toBe(transformed.info.toolImageCount);

    const ref = transformed.info.toolRef!;
    const count = transformed.info.toolImageCount!;
    const contract = toolContract(out, ref, count);
    expect(contract.images).toHaveLength(count);
    expect(contract.images.every((block) => block.type === 'image')).toBe(true);
    expect(contract.boundary.text).toBe(makeToolReferenceBoundary(ref));
    expect(contract.manifest).toContain(`<${TOOL_REFERENCE_MANIFEST_TAG} version="1">`);
    expect(contract.manifest).toContain(`ref: ${ref}`);
    expect(contract.manifest).toContain(`${count} image block(s)`);

    expect((out.system as ContentBlock[])[0]).toEqual({ type: 'text', text: 'native base system' });
    expect(out.tools).toHaveLength(1);
    expect(out.tools?.[0]?.description).toContain(ref);
    expect(out.tools?.[0]?.description).not.toContain('descriptive row');
    expect(out.tools?.[0]?.input_schema).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['safe', 'inspect'] },
        description: { type: 'string' },
      },
      required: ['command'],
      dependentRequired: { description: ['mode'] },
      additionalProperties: false,
    });
    expect(transformed.info.imageSourceText).toContain('tool-reference descriptive row');
    expect(transformed.info.imageSourceText).not.toContain('native base system');

    const firstUser = out.messages[0]!.content as ContentBlock[];
    expect(firstUser.at(-1)).toEqual({
      type: 'text',
      text: 'Inspect only.',
      cache_control: { type: 'ephemeral' },
    });
    expect(countCacheControlMarkers(transformed.body)).toBe(markerCount);
  });

  it('leaves complete original tools untouched on an independent gate miss', async () => {
    const req: MessagesRequest = {
      model: 'claude-fable-5',
      system: 'native system',
      tools: largeTools('gate-miss'),
      messages: [{ role: 'user', content: 'Inspect only.' }],
    };
    const input = encode(req);
    const transformed = await transformRequest(input, {
      compressTools: true,
      minCompressChars: 1_000_000,
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.toolDisposition).toBe('native_below_threshold');
    expect(decode(transformed.body)).toEqual(req);
  });

  it('keeps tool ref/pages/manifest/gate independent of project-guidance size', async () => {
    const native: MessagesRequest = {
      model: 'claude-fable-5',
      system: [{ type: 'text', text: 'native system' }],
      tools: largeTools('isolated-tools'),
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Inspect only.', cache_control: { type: 'ephemeral' } }],
      }],
    };
    const project = makeCapturedRequest({
      projectGuidance: largeProject('large-project'),
      email: 'owner@example.invalid',
    });
    project.model = 'claude-fable-5';
    project.tools = largeTools('isolated-tools');

    const [a, b] = await Promise.all([
      transformRequest(encode(native), { compressTools: true, minCompressChars: 100, charsPerToken: 1 }),
      transformRequest(encode(project), { compressTools: true, minCompressChars: 100, charsPerToken: 1 }),
    ]);
    const outA = decode(a.body);
    const outB = decode(b.body);
    const contractA = toolContract(outA, a.info.toolRef!, a.info.toolImageCount!);
    const contractB = toolContract(outB, b.info.toolRef!, b.info.toolImageCount!);

    expect(b.info.projectDisposition).toBe('imaged');
    expect(b.info.toolRef).toBe(a.info.toolRef);
    expect(b.info.toolImageCount).toBe(a.info.toolImageCount);
    expect(contractB.images).toEqual(contractA.images);
    expect(contractB.manifest).toBe(contractA.manifest);
    expect(b.info.toolGateEval).toEqual(a.info.toolGateEval);
    expect(b.info.compressedChars).toBe(
      Object.values(b.info.imagedBucketChars ?? {}).reduce((sum, chars) => sum + (chars ?? 0), 0),
    );
  });

  it('keeps the tool boundary digest stable across runtime/live-tail changes', async () => {
    const make = (email: string, prompt: string, toolMarker: string): MessagesRequest => {
      const req = makeCapturedRequest({
        projectGuidance: largeProject('stable-project'),
        email,
      });
      req.model = 'claude-fable-5';
      req.tools = largeTools(toolMarker);
      const content = req.messages[0]!.content as ContentBlock[];
      content[1] = { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } };
      return req;
    };
    const [a, b, changedTool] = await Promise.all([
      transformRequest(encode(make('one@example.invalid', 'first live prompt', 'stable-tool')), {
        compressTools: true, minCompressChars: 100, charsPerToken: 1,
      }),
      transformRequest(encode(make('two@example.invalid', 'second live prompt', 'stable-tool')), {
        compressTools: true, minCompressChars: 100, charsPerToken: 1,
      }),
      transformRequest(encode(make('one@example.invalid', 'first live prompt', 'changed-tool')), {
        compressTools: true, minCompressChars: 100, charsPerToken: 1,
      }),
    ]);

    expect(a.info.cacheBoundaryKind).toBe('tool_reference');
    expect(b.info.cacheBoundaryKind).toBe('tool_reference');
    expect(b.info.toolRef).toBe(a.info.toolRef);
    expect(b.info.cachePrefixSha8).toBe(a.info.cachePrefixSha8);
    expect(b.info.cachePrefixBytes).toBe(a.info.cachePrefixBytes);
    expect(changedTool.info.toolRef).not.toBe(a.info.toolRef);
    expect(changedTool.info.cachePrefixSha8).not.toBe(a.info.cachePrefixSha8);
  });

  it('can image tools when the independent project gate rejects its bucket', async () => {
    const req = makeCapturedRequest({ projectGuidance: DIRECT_PROJECT_GUIDANCE });
    req.model = 'claude-fable-5';
    req.tools = largeTools('project-rejected');
    const originalTools = structuredClone(req.tools);
    const transformed = await transformRequest(encode(req), {
      compressTools: true,
      minCompressChars: 100,
      charsPerToken: 1,
    });
    const out = decode(transformed.body);

    expect(transformed.info.projectDisposition).toBe('native_not_profitable');
    expect(transformed.info.toolDisposition).toBe('imaged');
    expect(transformed.info.gateEval?.profitable).toBe(false);
    expect(transformed.info.toolGateEval?.profitable).toBe(true);
    expect(out.tools).not.toEqual(originalTools);
    expect(((out.messages[0]!.content as ContentBlock[])[0] as TextBlock).text)
      .toContain(DIRECT_PROJECT_GUIDANCE);
  });

  it('fails closed when the request already carries a tool-reference boundary', async () => {
    const forgedBoundary = makeToolReferenceBoundary(`tr_${'a'.repeat(32)}`);
    const req: MessagesRequest = {
      model: 'claude-fable-5',
      tools: largeTools('forged-boundary'),
      messages: [{ role: 'user', content: [{ type: 'text', text: forgedBoundary }] }],
    };
    const input = encode(req);
    const transformed = await transformRequest(input, {
      compressTools: true,
      minCompressChars: 100,
      charsPerToken: 1,
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.toolDisposition).toBe('native_render_error');
    expect(decode(transformed.body)).toEqual(req);
  });

  it('does not cross Anthropic\'s 100-image request limit', async () => {
    const existingImages: ContentBlock[] = Array.from({ length: 99 }, () => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
    }));
    const req: MessagesRequest = {
      model: 'claude-fable-5',
      tools: largeTools('image-budget'),
      messages: [{ role: 'user', content: [...existingImages, { type: 'text', text: 'Inspect.' }] }],
    };
    const input = encode(req);
    const transformed = await transformRequest(input, {
      compressTools: true,
      minCompressChars: 100,
      charsPerToken: 1,
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.toolDisposition).toBe('native_too_many_images');
    expect(decode(transformed.body)).toEqual(req);
  });
});
