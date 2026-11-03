import { describe, expect, it } from 'vitest';

import { renderPage } from '../src/auth/page.js';

describe('renderPage', () => {
  const html = renderPage('Sign in <here>', '<form><h1>x</h1></form>');

  it('follows the system colour scheme, dark by default', () => {
    expect(html).toContain('color-scheme: light dark');
    expect(html).toContain('--bg: #111826');
    expect(html).toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root \{ --bg: #f3f4f6/);
  });

  it('styles the fields a code or a choice needs, not only the password', () => {
    expect(html).toContain('input[type=password], input[type=text], select {');
  });

  it('carries no script, which the pages CSP would refuse anyway', () => {
    expect(html).not.toMatch(/<script/i);
  });

  it('escapes the title', () => {
    expect(html).toContain('<title>Sign in &#60;here&#62;</title>');
  });
});
