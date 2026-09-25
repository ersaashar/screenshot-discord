import screenshot from 'screenshot-desktop';

// ponytail: one-shot CLI display enumeration; add interactive selection prompt when interactive setup flow needed.
const displays = await screenshot.listDisplays();
console.log(`${displays.length} display(s) detected:\n`);
displays.forEach((d, i) => {
  const item = d as { id: string | number; width?: number; height?: number };
  const res = item.width && item.height ? ` (${item.width}×${item.height})` : '';
  console.log(`  ${i + 1}: ${d.id}${res}`);
});
