function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function upsertManagedSection(
  content: string,
  startMarker: string,
  endMarker: string,
  section: string,
  legacyPatterns: RegExp[],
): string {
  let next = content;
  for (const pattern of legacyPatterns) {
    next = next.replace(pattern, '\n');
  }

  const blockPattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\s*`, 'g');
  next = next.replace(blockPattern, '\n');

  const strayMarkerPattern = new RegExp(
    `^\\s*(?:${escapeRegExp(startMarker)}|${escapeRegExp(endMarker)})\\s*$\\n?`,
    'gm',
  );
  next = next.replace(strayMarkerPattern, '');

  next = next.replace(/\n{3,}/g, '\n\n').trimEnd();
  return [next, section].filter(Boolean).join('\n\n').trimEnd() + '\n';
}
