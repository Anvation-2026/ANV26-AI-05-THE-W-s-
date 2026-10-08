/** Errors from the back end, kept in the plain-language shape the server sends: what happened and how to fix it. */
export interface Problem {
  code: string;
  status: number;
  title: string;
  detail: string;
  fix: string;
  correlationId?: string;
  retryAfterS?: number;
}

export class ApiProblem extends Error implements Problem {
  code: string;
  status: number;
  title: string;
  detail: string;
  fix: string;
  correlationId?: string;
  retryAfterS?: number;
  constructor(p: Problem) {
    super(`${p.title}. ${p.detail} ${p.fix}`.trim());
    this.name = 'ApiProblem';
    this.code = p.code;
    this.status = p.status;
    this.title = p.title;
    this.detail = p.detail;
    this.fix = p.fix;
    this.correlationId = p.correlationId;
    this.retryAfterS = p.retryAfterS;
  }
}

export function networkProblem(baseUrl: string): ApiProblem {
  const mixed = typeof location !== 'undefined' && location.protocol === 'https:' && baseUrl.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl);
  return new ApiProblem({
    code: 'network',
    status: 0,
    title: 'The server could not be reached',
    detail: mixed ? `This page is on https, and the browser blocks the plain http address ${baseUrl}.` : `There was no answer from ${baseUrl}.`,
    fix: mixed ? 'Serve the back end over https, or open this app from http://localhost.' : 'Check that the back end is running (see the README) and that its address in the Back end settings is right, then try again.',
  });
}

export interface Friendly {
  title: string;
  detail: string;
  fix: string;
  reference?: string;
}

/** Turns anything thrown into a title, a detail and a fix that can be shown to a person as they are. */
export function friendlyError(e: unknown): Friendly {
  if (e instanceof ApiProblem) return { title: e.title, detail: e.detail, fix: e.fix, reference: e.correlationId };
  if (e instanceof DOMException && e.name === 'AbortError') return { title: 'Stopped', detail: 'The analysis was cancelled.', fix: 'Start it again when you are ready.' };
  if (e instanceof Error && e.name === 'NotConnectedError') return { title: 'The back end is not connected', detail: e.message, fix: 'Start the back end and press Check again in the Back end settings, or continue with the sample junction.' };
  if (e instanceof Error && e.name === 'ZodError') return { title: 'The result is not in the expected format', detail: 'The server sent data this version of the app cannot read.', fix: 'Update the front end and the back end to the same version.' };
  if (e instanceof Error) return { title: 'Something went wrong', detail: e.message, fix: 'Try again. If it keeps happening, reload the page.' };
  return { title: 'Something went wrong', detail: 'An unknown error occurred.', fix: 'Try again. If it keeps happening, reload the page.' };
}
