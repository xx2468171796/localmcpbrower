/**
 * Client-side deferred tool loading, the way Claude Code does it with tool search on (what company PCs run): MCP tools
 * are listed by name only, a ToolSearch tool returns full definitions ("select:a,b" or keywords) that become callable
 * from the next request on. Tools marked _meta["anthropic/alwaysLoad"] are sent in full from the start. So "can the AI
 * find the right tool" is part of what the exam measures. BM25 over name + title + description + parameter names, CJK
 * characters as single tokens (port of admin/baolei tools/mcp-exam/runner/tool-search.ts). Judge layer.
 */
const STOP = new Set('a an the and or of to in on for with by from is are be this that it as at use when how what which'.split(' '));

export function tokenize(text) {
  const spaced = String(text).replace(/[㐀-鿿]/g, (c) => ` cjk${c.codePointAt(0).toString(36)} `).toLowerCase();
  return (spaced.match(/[a-z0-9_]+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => (w.length > 4 && !w.includes('_') && !w.startsWith('cjk') ? w.replace(/(ing|ed|es|s)$/, '') : w));
}

export class ToolSearch {
  static NAME = 'ToolSearch';

  constructor(deferred) {
    this.deferred = deferred;
    this.df = new Map();
    this.docs = deferred.map((t) => {
      const props = Object.keys(t.inputSchema?.properties ?? {});
      const tokens = tokenize([t.name, t.name.replace(/_/g, ' '), t.title ?? '', t.description ?? '', ...props].join(' '));
      const tf = new Map();
      for (const w of tokens) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      return { name: t.name, tf, len: tokens.length };
    });
    this.avg = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(1, this.docs.length);
  }

  static definition() {
    return {
      name: ToolSearch.NAME,
      description:
        'Fetches full schema definitions for deferred tools so they can be called. Deferred tools are listed by name in the system prompt; until fetched, only the name is known and the tool cannot be invoked. '
        + 'Query forms: "select:Read,Edit" fetches these exact tools; keywords (English works best) search names and descriptions. Matched tools become callable in your next turn.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.' },
          max_results: { type: 'number', description: 'Maximum number of results to return (default: 5)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    };
  }

  find(query, max = 5) {
    const q = String(query).trim();
    if (q.startsWith('select:')) {
      const wanted = q.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
      return this.deferred.filter((t) => wanted.includes(t.name)).map((t) => t.name);
    }
    const terms = [...new Set(tokenize(q))];
    const n = this.docs.length;
    return this.docs
      .map((d) => {
        let score = 0;
        for (const w of terms) {
          const f = d.tf.get(w);
          if (!f) continue;
          const df = this.df.get(w);
          score += (Math.log(1 + (n - df + 0.5) / (df + 0.5)) * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / this.avg));
        }
        return { name: d.name, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, Number(max) || 5)))
      .map((r) => r.name);
  }

  render(names) {
    if (!names.length) return 'No matching deferred tools found. Try other English keywords or select:<exact tool name> from the deferred list.';
    const defs = names.map((name) => {
      const t = this.deferred.find((x) => x.name === name);
      return `<function>${JSON.stringify({ description: t.description ?? '', name: t.name, parameters: t.inputSchema })}</function>`;
    });
    return `<functions>\n${defs.join('\n')}\n</functions>`;
  }
}
