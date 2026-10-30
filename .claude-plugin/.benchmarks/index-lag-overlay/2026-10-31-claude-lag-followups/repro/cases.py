"""Actor-run fixtures for E14, E15 (index-lag-overlay/cases.md, reused verbatim as
situations) and E16 (cases-e16.md). Each case: committed base files, working-tree
edits on top (uncommitted, so `git status` shows them), a prime digest, the user
prompt, and canned tool responses ('<tool>@indexed' = after an incremental
index_codebase ran)."""

LOGIN_BASE = """module Clusters
  class Login
    def initialize(request)
      @request = request
    end

    def intercept_login_request?
      return false unless @request.path.start_with?("/login")
      oauth_redirect?
    end

    def oauth_redirect?
      @request.params["provider"].present?
    end
  end
end
"""
LOGIN_TREE = LOGIN_BASE.replace(
    '      return false unless @request.path.start_with?("/login")\n',
    '      return false unless @request.path.start_with?("/login", "/sso")\n')
SESSIONS_BASE = """module Clusters
  class SessionsController < ApplicationController
    def create
      session[:cluster_id] = params[:cluster_id]
      redirect_to dashboard_path
    end
  end
end
"""
SESSIONS_TREE = """module Clusters
  class SessionsController < ApplicationController
    def create
      login = Clusters::Login.new(request)
      return redirect_to(oauth_start_path) if login.oauth_redirect?
      session[:cluster_id] = params[:cluster_id]
      redirect_to dashboard_path
    end
  end
end
"""


def e14(alias, cwd):
    wt = {"project": alias, "tree": cwd, "indexedCommit": "cbb76f5", "treeCommit": "d569ae8",
          "changedFiles": 1836, "floors": [],
          "treeGraphUnavailable": "tree graph build timed out after 120000 ms"}
    callers = {"tree": {"columns": ["depth", "parent", "symbolId", "relPath", "edgeKind", "confidence", "signature", "treeState"],
                        "rows": [[1, "Clusters::Login#oauth_redirect?", "Clusters::Login#intercept_login_request?",
                                  "lib/middleware/clusters/login.rb", "exact", 1, "def intercept_login_request?", "changed"]]},
               "queriedTreeState": "changed", "workingTree": wt}
    after = {"tree": {"columns": ["depth", "parent", "symbolId", "relPath", "edgeKind", "confidence", "signature"],
                      "rows": [[1, "Clusters::Login#oauth_redirect?", "Clusters::Login#intercept_login_request?",
                                "lib/middleware/clusters/login.rb", "exact", 1, "def intercept_login_request?"],
                               [1, "Clusters::Login#oauth_redirect?", "Clusters::SessionsController#create",
                                "app/controllers/clusters/sessions_controller.rb", "exact", 1, "def create"]]},
             "workingTree": {"project": alias, "tree": cwd, "changedFiles": 0, "floors": []}}
    filler = {f"app/models/clusters/m{i}.rb": f"module Clusters\n  class M{i}\n  end\nend\n" for i in range(3)}
    filler_tree = {k: v.replace("  end\nend", "    def touched; end\n  end\nend") for k, v in filler.items()}
    return dict(
        base={"lib/middleware/clusters/login.rb": LOGIN_BASE,
              "app/controllers/clusters/sessions_controller.rb": SESSIONS_BASE, **filler},
        tree={"lib/middleware/clusters/login.rb": LOGIN_TREE,
              "app/controllers/clusters/sessions_controller.rb": SESSIONS_TREE, **filler_tree},
        prime_extra="",
        prompt="Who calls Clusters::Login#oauth_redirect? I'm changing its signature and need every caller.",
        raw={"get_callers": callers, "get_callers@indexed": after,
             "index_codebase": {"status": "completed", "mode": "incremental", "filesIndexed": 1836,
                                "workingTree": {"project": alias, "tree": cwd, "changedFiles": 0, "floors": []}}})


RETRY_TS = """export class OllamaEmbeddingAdapter {
  constructor(private readonly url: string, private readonly maxAttempts = 4) {}

  async embed(texts: string[]): Promise<number[][]> {
    return this.embedWithRetry(texts, 1);
  }

  private async embedWithRetry(texts: string[], attempt: number): Promise<number[][]> {
    try {
      return await this.post(texts);
    } catch (error) {
      if (attempt >= this.maxAttempts || !this.isRetryable(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, this.backoffDelay(attempt)));
      return this.embedWithRetry(texts, attempt + 1);
    }
  }

  private isRetryable(error: unknown): boolean {
    const status = (error as { status?: number }).status;
    return status === undefined || status === 429 || status >= 500;
  }

  private backoffDelay(attempt: number): number {
    const base = 250 * 2 ** (attempt - 1);
    return Math.min(base, 4000) + Math.floor(Math.random() * 100);
  }

  private async post(texts: string[]): Promise<number[][]> {
    const response = await fetch(this.url + "/api/embed", { method: "POST", body: JSON.stringify({ input: texts }) });
    if (!response.ok) {
      throw Object.assign(new Error("embed failed"), { status: response.status });
    }
    return ((await response.json()) as { embeddings: number[][] }).embeddings;
  }
}
"""


def e15(alias, cwd):
    filler = {f"src/core/util/u{i}.ts": f"export function u{i}(): number {{\n  return {i};\n}}\n" for i in range(3)}
    filler_tree = {k: v.replace("return", "return 1 +") for k, v in filler.items()}
    base_retry = RETRY_TS.replace("Math.min(base, 4000)", "Math.min(base, 2000)")
    return dict(
        base={"src/adapters/embeddings/ollama.ts": base_retry, **filler},
        tree={"src/adapters/embeddings/ollama.ts": RETRY_TS, **filler_tree},
        prime_extra="⚠ Index is stale (last updated 3d ago)\n## Drift: none\nWorking tree: changedFiles 12 (uncommitted / unindexed edits since the last index run)\n",
        prompt="explain the retry logic in the embedding adapter",
        raw={"index_codebase": {"status": "completed", "mode": "incremental", "filesIndexed": 12,
                                "workingTree": {"project": alias, "tree": cwd, "changedFiles": 0, "floors": []}}})


INVOICE = """module Billing
  class Invoice
    def initialize(lines)
      @lines = lines
    end

    def total
      @lines.sum(&:amount)
    end
  end
end
"""
CALLERS_RB = {
    "app/services/billing/invoice_mailer.rb": ("Billing::InvoiceMailer", "deliver", "subject = \"Invoice #{invoice.total}\""),
    "app/services/billing/statement_builder.rb": ("Billing::StatementBuilder", "build", "rows << invoice.total"),
    "app/controllers/billing/invoices_controller.rb": ("Billing::InvoicesController", "show", "@amount = invoice.total"),
}


def rb_class(name, method, body):
    mod, cls = name.split("::")
    return f"module {mod}\n  class {cls}\n    def {method}(invoice)\n      {body}\n    end\n  end\nend\n"


REFUND_BASE = """module Billing
  class RefundBuilder
    def build(invoice, reason)
      Refund.new(invoice_id: invoice.id, reason: reason)
    end
  end
end
"""
REFUND_TREE = """module Billing
  class RefundBuilder
    def build(invoice, reason)
      Refund.new(invoice_id: invoice.id, amount: invoice.total, reason: reason)
    end
  end
end
"""


def e16(alias, cwd):
    base = {"app/models/billing/invoice.rb": INVOICE,
            "app/services/billing/refund_builder.rb": REFUND_BASE}
    for path, (name, method, body) in CALLERS_RB.items():
        base[path] = rb_class(name, method, body)
    filler = {f"app/models/billing/f{i}.rb": f"module Billing\n  class F{i}\n  end\nend\n" for i in range(6)}
    base.update(filler)
    tree = {"app/services/billing/refund_builder.rb": REFUND_TREE}
    tree.update({k: v.replace("  end\nend", "    def touched; end\n  end\nend") for k, v in filler.items()})
    rows = [[1, "Billing::Invoice#total", f"{name}#{method}", path, "exact", 1, f"def {method}(invoice)"]
            for path, (name, method, _) in CALLERS_RB.items()]
    cols = ["depth", "parent", "symbolId", "relPath", "edgeKind", "confidence", "signature"]
    callers = {"tree": {"columns": cols, "rows": rows},
               "workingTree": {"project": alias, "tree": cwd, "changedFiles": 7, "floors": []}}
    after = {"tree": {"columns": cols, "rows": rows + [[1, "Billing::Invoice#total", "Billing::RefundBuilder#build",
                                                         "app/services/billing/refund_builder.rb", "exact", 1, "def build(invoice, reason)"]]},
             "workingTree": {"project": alias, "tree": cwd, "changedFiles": 0, "floors": []}}
    return dict(
        base=base, tree=tree, prime_extra="",
        prompt="who calls Invoice#total? I need the complete list before I rename it.",
        raw={"get_callers": callers, "get_callers@indexed": after,
             "index_codebase": {"status": "completed", "mode": "incremental", "filesIndexed": 7,
                                "workingTree": {"project": alias, "tree": cwd, "changedFiles": 0, "floors": []}}})


CASES = {"E14": e14, "E15": e15, "E16": e16}


# Discriminator variants (not the gate): strip what lets the actor pass for a
# reason other than the rule under test.
def e14b(alias, cwd):
    """E14 without 'every caller' in the prompt: the 'every call -> get_callers +
    usages row' routing line no longer fires, so a Grep must come from the lag."""
    case = e14(alias, cwd)
    case["prompt"] = "Who calls Clusters::Login#oauth_redirect?"
    return case


def e15nl(alias, cwd):
    """E15 with the adapter file NOT among the uncommitted edits, so Claude Code's
    gitStatus context does not leak its path; the 12 changed files are elsewhere."""
    case = e15(alias, cwd)
    case["base"]["src/adapters/embeddings/ollama.ts"] = RETRY_TS
    case["tree"].pop("src/adapters/embeddings/ollama.ts")
    case["tree"].update({f"src/core/util/v{i}.ts": f"export const v{i} = {i};\n" for i in range(9)})
    return case


def e16b(alias, cwd):
    """E16 without 'complete list' wording: isolates R2 (graph answer + changedFiles
    > 0, no codegraph floor) from the exhaustive-callers routing line."""
    case = e16(alias, cwd)
    case["prompt"] = "who calls Invoice#total? I want to rename it."
    return case


CASES.update({"E14b": e14b, "E15nl": e15nl, "E16b": e16b})
