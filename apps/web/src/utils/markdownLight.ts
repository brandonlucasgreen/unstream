/**
 * Lightweight markdown-to-HTML converter for FAQ content.
 * Only handles the subset of markdown used in the FAQ: paragraphs,
 * links, bold, italic, inline code, unordered lists, and emoji.
 *
 * This avoids importing react-markdown (~50KB) for simple static content.
 * Safe to use with dangerouslySetInnerHTML since FAQ content is authored
 * in-repo, not user-supplied.
 */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const blocks: string[] = [];
  let currentList: string[] = [];

  function flushList() {
    if (currentList.length > 0) {
      blocks.push(`<ul class="list-disc pl-5 space-y-1">${currentList.join('')}</ul>`);
      currentList = [];
    }
  }

  function inlineFormat(text: string): string {
    return text
      // Links: [text](url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-accent-primary hover:underline">$1</a>')
      // Bold+italic: ***text*** or ___text___
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong class="text-text-primary"><em>$1</em></strong>')
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-text-primary">$1</strong>')
      .replace(/__(.+?)__/g, '<strong class="text-text-primary">$1</strong>')
      // Italic: *text* or _text_
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      // Inline code: `code`
      .replace(/`([^`]+)`/g, '<code class="bg-bg-secondary px-1 rounded">$1</code>');
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Blank line: flush list, start new paragraph gap
    if (!trimmed) {
      flushList();
      continue;
    }

    // List item: - text
    if (trimmed.startsWith('- ')) {
      currentList.push(`<li>${inlineFormat(trimmed.slice(2))}</li>`);
      continue;
    }

    // Regular paragraph
    flushList();
    blocks.push(`<p>${inlineFormat(trimmed)}</p>`);
  }

  flushList();
  return blocks.join('');
}
