/**
 * Connected components over a weight-thresholded edge set — the shared
 * clustering primitive of the behavioral-cohesion family (bd
 * tea-rags-mcp-tzy8r + tea-rags-mcp-w7be6). A3 clusters a file's symbols over
 * co-change history, D1 a class's methods over structure; both ask which
 * parts hang together above a weight floor and how far the whole is from one
 * component. Pure graph math, foundation layer like Tarjan/PageRank — no
 * domain vocabulary, no git, no AST.
 *
 * Nodes are NOT an input: the components are those the admitted edges span,
 * and a node in no admitted edge is the caller's "unclustered" set (absence
 * of a cluster is evidence of its own, and only the caller knows the full
 * node universe).
 */

/** One weighted, undirected candidate edge. */
export interface WeightedNodeEdge {
  readonly a: string;
  readonly b: string;
  readonly weight: number;
}

/** A connected component of admitted edges, with the weight inside it. */
export interface WeightedComponent {
  readonly nodes: readonly string[];
  /** Sum of admitted edge weights with both endpoints in the component. */
  readonly internalWeight: number;
}

export interface WeightedComponentAnalysis {
  /** Largest internal weight first; ties broken by first member, alphabetically. */
  readonly components: readonly WeightedComponent[];
  /**
   * The largest component's share of all admitted weight in [0,1] — 1 means
   * everything hangs together (or there is no admitted edge at all, which is
   * "nothing contradicts cohesion", never "measured cohesion").
   */
  readonly largestWeightShare: number;
}

export function weightThresholdComponents(
  edges: readonly WeightedNodeEdge[],
  options: { minWeight: number },
): WeightedComponentAnalysis {
  const admitted = edges.filter((e) => e.weight >= options.minWeight);
  if (admitted.length === 0) return { components: [], largestWeightShare: 1 };

  // Union-find over the endpoints of admitted edges.
  const parent = new Map<string, string>();
  const find = (start: string): string => {
    let root = start;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let current = start;
    while (parent.get(current) !== root) {
      const next = parent.get(current) as string;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (x: string, y: string): void => {
    for (const node of [x, y]) if (!parent.has(node)) parent.set(node, node);
    const [rx, ry] = [find(x), find(y)];
    if (rx !== ry) parent.set(ry, rx);
  };
  for (const edge of admitted) union(edge.a, edge.b);

  const members = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    const list = members.get(root);
    if (list) list.push(node);
    else members.set(root, [node]);
  }
  const weightByRoot = new Map<string, number>();
  let totalWeight = 0;
  for (const edge of admitted) {
    const root = find(edge.a);
    weightByRoot.set(root, (weightByRoot.get(root) ?? 0) + edge.weight);
    totalWeight += edge.weight;
  }

  const compareStrings = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  const components = [...members.entries()]
    .map(([root, nodes]) => ({
      nodes: nodes.sort(compareStrings),
      internalWeight: weightByRoot.get(root) ?? 0,
    }))
    .sort((x, y) => y.internalWeight - x.internalWeight || compareStrings(x.nodes[0], y.nodes[0]));

  return { components, largestWeightShare: components[0].internalWeight / totalWeight };
}
