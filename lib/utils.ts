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
