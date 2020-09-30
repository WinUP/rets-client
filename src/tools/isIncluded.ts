export function isIncluded<T>(target: (v: T) => boolean, source?: T | T[]): boolean {
    if (!source) { return false; }
    return source instanceof Array ? source.some(target) : target(source);
}
