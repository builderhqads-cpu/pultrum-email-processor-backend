import { AiClientService } from './ai-client.service';

describe('AiClientService.resolveAiRequestUrl', () => {
  it('uses absolute AI_API_URL as-is', () => {
    const prisma: any = {};
    const config: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_URL') return 'https://example.com/process';
        return '';
      }),
    };
    const service = new AiClientService(prisma, config);
    const url = (service as any).resolveAiRequestUrl();
    expect(url).toBe('https://example.com/process');
  });

  it('combines AI_API_BASE_URL + relative AI_API_URL', () => {
    const prisma: any = {};
    const config: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_URL') return '/process';
        if (key === 'AI_API_BASE_URL') return 'https://router.example.com';
        return '';
      }),
    };
    const service = new AiClientService(prisma, config);
    const url = (service as any).resolveAiRequestUrl();
    expect(url).toBe('https://router.example.com/process');
  });

  it('defaults to /process when only AI_API_BASE_URL is set', () => {
    const prisma: any = {};
    const config: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_API_URL') return '';
        if (key === 'AI_API_BASE_URL') return 'https://router.example.com/';
        return '';
      }),
    };
    const service = new AiClientService(prisma, config);
    const url = (service as any).resolveAiRequestUrl();
    expect(url).toBe('https://router.example.com/process');
  });
});

describe('AiClientService.extractSuggestedReply', () => {
  it('prefers replyBody', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedReply({replyBody: 'Only body'});
    expect(out).toBe('Only body');
  });

  it('extracts from response.output', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedReply({output: 'Hello'});
    expect(out).toBe('Hello');
  });

  it('extracts from OpenAI chat-completions style choices[0].message.content', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedReply({
      id: 'x',
      choices: [{message: {role: 'assistant', content: 'Suggested reply'}}],
      usage: {total_tokens: 10},
    });
    expect(out).toBe('Suggested reply');
  });

  it('extracts from nested data wrapper', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedReply({data: {output_text: 'Hi'}});
    expect(out).toBe('Hi');
  });

  it('extracts from top-level body', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedReply({body: 'Formatted\n\nBody'});
    expect(out).toBe('Formatted\n\nBody');
  });

  it('extracts body from JSON content inside choices[0].message.content', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedReply({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subject: 'Missing Transport Order Information',
              body: 'Good morning,\n\nPlease confirm the pickup date.',
            }),
          },
        },
      ],
    });
    expect(out).toBe('Good morning,\n\nPlease confirm the pickup date.');
  });
});

describe('AiClientService.extractSuggestedSubject', () => {
  it('extracts replySubject', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedSubject({replySubject: 'Subj'});
    expect(out).toBe('Subj');
  });

  it('extracts subject from top-level subject', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedSubject({subject: 'Subj'});
    expect(out).toBe('Subj');
  });

  it('extracts subject from JSON content inside choices[0].message.content', () => {
    const service = new AiClientService({} as any, {get: jest.fn()} as any);
    const out = (service as any).extractSuggestedSubject({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subject: 'Missing Transport Order Information',
              body: 'Body',
            }),
          },
        },
      ],
    });
    expect(out).toBe('Missing Transport Order Information');
  });
});
