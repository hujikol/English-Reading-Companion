/**
 * Durability tiers from Section 12. Three tiers, three different lifetimes.
 * H's quota recovery may only evict `derived`. Never `user`.
 */

export const DURABILITY = {
  documents: "user",
  assets: "user",
  progress: "user",
  bookmarks: "user",
  marks: "user",
  vocabulary: "user",
  occurrences: "user",
  reviewCards: "user",
  reviewEvents: "user",
  explanations: "user",
  semanticPages: "derived",
  aiCache: "derived",
  settings: "user",
} as const;

export type TableName = keyof typeof DURABILITY;
export type Durability = (typeof DURABILITY)[TableName];

export const isEvictable = (t: TableName): boolean => DURABILITY[t] === "derived";
