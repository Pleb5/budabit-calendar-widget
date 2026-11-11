import DOMPurify from 'dompurify';
import {marked} from 'marked';

// Parse the complete Markdown before rendering: truncating source text can cut
// an image URL in half and expose its markup instead of the image.
export function renderEventDescription(content: string): string {
  const fragment = DOMPurify.sanitize(marked.parse(content.trim(), {async: false, breaks: true}), {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'a', 'img', 'ul', 'ol', 'li',
      'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'hr',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const link of fragment.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}
