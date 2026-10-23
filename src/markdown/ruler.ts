// An ordered, named rule list. A rule may also join named chains, such as the
// rules that may end a paragraph; `getRules(chain)` lists a chain's enabled rules.
interface Rule<T> { name: string; enabled: boolean; fn: T; alt: string[] }
export interface RuleOptions { alt?: readonly string[] }

export class Ruler<T> {
  private rules: Rule<T>[] = [];
  private cache: Map<string, T[]> | undefined;
  private index(name: string): number {
    const index = this.rules.findIndex(rule => rule.name === name);
    if (index < 0) throw new Error(`Parser rule not found: ${name}`);
    return index;
  }
  /** A rule's function and chains, for wrapping it. */
  get(name: string): { fn: T; alt: readonly string[] } {
    const rule = this.rules[this.index(name)]!;
    return { fn: rule.fn, alt: rule.alt };
  }
  at(name: string, fn: T, options: RuleOptions = {}): void {
    const rule = this.rules[this.index(name)]!;
    rule.fn = fn; rule.alt = [...options.alt ?? []]; this.cache = undefined;
  }
  before(beforeName: string, name: string, fn: T, options: RuleOptions = {}): void {
    this.rules.splice(this.index(beforeName), 0, { name, enabled: true, fn, alt: [...options.alt ?? []] }); this.cache = undefined;
  }
  after(afterName: string, name: string, fn: T, options: RuleOptions = {}): void {
    this.rules.splice(this.index(afterName) + 1, 0, { name, enabled: true, fn, alt: [...options.alt ?? []] }); this.cache = undefined;
  }
  push(name: string, fn: T, options: RuleOptions = {}): void {
    this.rules.push({ name, enabled: true, fn, alt: [...options.alt ?? []] }); this.cache = undefined;
  }
  /** Enable the named rules; returns the names this ruler holds. */
  enable(names: readonly string[], ignoreInvalid = false): string[] {
    return this.toggle(names, true, ignoreInvalid);
  }
  disable(names: string | readonly string[], ignoreInvalid = false): string[] {
    return this.toggle(typeof names === "string" ? [names] : names, false, ignoreInvalid);
  }
  enableOnly(names: readonly string[]): void {
    for (const rule of this.rules) rule.enabled = false;
    this.enable(names);
  }
  private toggle(names: readonly string[], enabled: boolean, ignoreInvalid: boolean): string[] {
    const found: string[] = [];
    for (const name of names) {
      const rule = this.rules.find(candidate => candidate.name === name);
      if (!rule) { if (ignoreInvalid) continue; throw new Error(`Rules manager: invalid rule name ${name}`); }
      rule.enabled = enabled; found.push(name);
    }
    this.cache = undefined;
    return found;
  }
  getRules(chain: string): T[] {
    if (!this.cache) {
      this.cache = new Map([["", this.rules.filter(rule => rule.enabled).map(rule => rule.fn)]]);
      for (const rule of this.rules) if (rule.enabled) for (const name of rule.alt) {
        if (!this.cache.has(name)) this.cache.set(name, this.rules.filter(candidate => candidate.enabled && candidate.alt.includes(name)).map(candidate => candidate.fn));
      }
    }
    return this.cache.get(chain) ?? [];
  }
}
