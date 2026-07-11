import { describe, expect, it } from 'vitest';
import { transformOptionsFromEnv } from '../src/worker.js';
import {
  transformAnthropicMessages,
  type PxpipeOptions,
} from '../src/core/library.js';
import { transformOpenAIChatCompletions } from '../src/core/openai.js';
import { buildAnthropicCandidate as transformRequest } from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest, TextBlock, ToolDef } from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
} from './fixtures/anthropic-context.js';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

const decode = <T>(body: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(body)) as T;

function largeProjectGuidance(): string {
  const rows = Array.from(
    { length: 2200 },
    (_, index) => `worker option governance row ${index}: preserve project provenance.`,
  ).join('\n');
  return `${DIRECT_PROJECT_GUIDANCE}\n\n${rows}`;
}

function nativeAnthropicTools(): ToolDef[] {
  return [{
    name: 'SyntheticInspect',
    description: 'Native Anthropic tool documentation. '.repeat(200),
    input_schema: {
      type: 'object',
      description: 'Root annotation must stay native by default.',
      properties: {
        path: { type: 'string', description: 'Path annotation must stay native.' },
      },
    },
  }];
}

describe('Worker provider-sensitive transform options', () => {
  it('omits provider-sensitive keys when their environment variables are unset', () => {
    const options = transformOptionsFromEnv({});

    expect(Object.prototype.hasOwnProperty.call(options, 'compressProjectGuidance')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'compressTools')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'compressReminders')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'cols')).toBe(false);
    expect(options.compress).toBe(true);
    expect(options.compressToolResults).toBe(true);
  });

  it('forwards explicit project/tool/reminder controls without inventing fallbacks', () => {
    expect(transformOptionsFromEnv({
      COMPRESS_PROJECT_GUIDANCE: '0',
      COMPRESS_TOOLS: 'true',
      COMPRESS_REMINDERS: 'false',
      COLS: '144',
    })).toMatchObject({
      compressProjectGuidance: false,
      compressTools: true,
      compressReminders: false,
      cols: 144,
    });
  });

  it('keeps OpenAI tool compression on when the shared Worker option is absent', async () => {
    const workerOptions = transformOptionsFromEnv({});
    const body = encode({
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: 'Stable OpenAI system instruction. '.repeat(1000) },
        { role: 'user', content: 'Inspect the synthetic project.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'inspect_project',
          description: 'Inspect a project. '.repeat(150),
          parameters: {
            type: 'object',
            description: 'OPENAI_ROOT_ANNOTATION',
            properties: {
              path: { type: 'string', description: 'OPENAI_PATH_ANNOTATION' },
            },
          },
        },
      }],
    });

    const result = await transformOpenAIChatCompletions(body, {
      ...workerOptions,
      charsPerToken: 1,
      minCompressChars: 1,
    });
    const out = decode<any>(result.body);

    expect(Object.prototype.hasOwnProperty.call(workerOptions, 'compressTools')).toBe(false);
    expect(result.info.compressed).toBe(true);
    expect(out.tools[0].function.parameters.description).toBeUndefined();
    expect(out.tools[0].function.parameters.properties.path.description).toBeUndefined();
  });

  it('uses Anthropic project-on/tool-and-reminder-native defaults from an empty Worker env', async () => {
    const options = transformOptionsFromEnv({});
    const req = makeCapturedRequest({ projectGuidance: largeProjectGuidance() });
    req.tools = nativeAnthropicTools();
    const originalTools = structuredClone(req.tools);
    const opening = req.messages[0]!.content as ContentBlock[];
    const reminder: TextBlock = {
      type: 'text',
      text: `<system-reminder>${'unknown native reminder '.repeat(1200)}</system-reminder>`,
    };
    opening.push(reminder);

    const result = await transformRequest(encode(req), {
      ...options,
      charsPerToken: 1,
      minCompressChars: 1,
    });
    const out = decode<MessagesRequest>(result.body);

    expect(result.info.projectDisposition).toBe('imaged');
    expect(out.tools).toEqual(originalTools);
    expect(JSON.stringify(out.messages)).toContain(reminder.text);
  });
});

describe('public Anthropic provenance controls', () => {
  it('exposes and forwards project/tool/reminder controls through PxpipeOptions', async () => {
    const options: PxpipeOptions = {
      compressProjectGuidance: false,
      compressTools: false,
      compressReminders: false,
      charsPerToken: 1,
    };
    const req = makeCapturedRequest({ projectGuidance: largeProjectGuidance() });
    req.model = 'claude-fable-5';
    req.tools = nativeAnthropicTools();

    const result = await transformAnthropicMessages({
      body: encode(req),
      model: 'claude-fable-5',
      options,
    });
    const out = decode<MessagesRequest>(result.body);
    const opening = out.messages[0]!.content as ContentBlock[];

    expect(result.applied).toBe(false);
    expect(result.body).toEqual(encode(req));
    expect(result.info.projectDisposition).toBeUndefined();
    expect(out.tools).toEqual(req.tools);
    expect(opening.some(
      (block) => block.type === 'text' && block.text.includes('worker option governance row 2199'),
    )).toBe(true);
  });
});
