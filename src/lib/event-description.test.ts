// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {renderEventDescription} from './event-description';

describe('calendar event descriptions', () => {
  it('renders a complete long Markdown image URL and the text after it', () => {
    const src = `https://blossom.example/${'a'.repeat(64)}.png`;
    const content = `![${'A detailed event illustration '.repeat(8)}](${src})\n\nDemo your **Freedom Tech** projects.`;
    const element = document.createElement('div');
    element.innerHTML = renderEventDescription(content);
    expect(element.querySelector('img')?.getAttribute('src')).toBe(src);
    expect(element.querySelector('strong')?.textContent).toBe('Freedom Tech');
    expect(element.textContent).not.toContain('![');
  });

  it('preserves paragraphs, lists, and links without allowing executable event HTML', () => {
    const element = document.createElement('div');
    element.innerHTML = renderEventDescription(
      'Welcome\n\n- Bring ideas\n- [Details](https://example.com)\n\n' +
      '<script>alert(1)</script><img src="https://example.com/image.png" onerror="alert(1)">' +
      '<a href="javascript:alert(1)">bad link</a><iframe src="https://example.com"></iframe>'
    );
    expect(element.querySelectorAll('li')).toHaveLength(2);
    expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(element.querySelector('script, iframe, [onerror], [href^="javascript:"]')).toBeNull();
  });
});
