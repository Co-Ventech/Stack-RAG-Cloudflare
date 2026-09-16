export interface DocMeta {
  id: string;
  title: string;
  createdAt: string;
  chunkCount: number;
  vectorIds: string[];
}

export function docKey(id: string): string {
  return `doc:${id}`;
}
