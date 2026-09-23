export type ClassValue = string | number | false | null | undefined;

/** Join truthy class names into a single string. */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}

/** "1 order", "3 orders"; pass `many` for irregular forms or verb phrases
 * ("order is" / "orders are", "email needs" / "emails need"). */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A Portrait Styles name as a person reads it. Names an admin typed with
 * capitals stay exactly as written; stored keys read as words:
 * "cartoon" -> "Cartoon", "line-art" -> "Line art". */
export function styleLabel(name: string): string {
  const trimmed = name.trim();
  if (/[A-Z]/.test(trimmed)) return trimmed;
  const words = trimmed.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
