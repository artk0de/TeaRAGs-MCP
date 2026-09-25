/**
 * One oversized symbol per AST-chunked language, holding EVERY block-forming
 * construct that grammar has (bd tea-rags-mcp-y5vx4). Each construct is small
 * enough to fit a part on its own; the trailing `big` loop is not, so its body
 * must be split by the same rule one level deeper.
 *
 * `constructs` lists the node types the harness checks cuts against. The
 * harness first asserts every listed type actually occurs inside the symbol —
 * a fixture cannot silently stop exercising a construct.
 */

export interface OversizedSymbolFixture {
  readonly filePath: string;
  readonly code: string;
  /** symbolId the split parts must be numbered under (`${base}#partN`). */
  readonly baseSymbolId: string;
  /** Block-forming node types of this grammar, each present in `code`. */
  readonly constructs: readonly string[];
  /** Opening line of the oversized loop: it must appear in a later part's context prefix. */
  readonly bigLoopHeader: string;
}

/** Statements of the oversized loop — together well past the budget. */
function lines(count: number, render: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => render(i)).join("\n");
}

const BIG = 30;

export const OVERSIZED_SYMBOL_FIXTURES: Readonly<Record<string, OversizedSymbolFixture>> = {
  typescript: {
    filePath: "src/worker.ts",
    baseSymbolId: "Worker#run",
    bigLoopHeader: "for (const big of items) {",
    constructs: [
      "if_statement",
      "else_clause",
      "for_statement",
      "for_in_statement",
      "while_statement",
      "do_statement",
      "switch_statement",
      "try_statement",
      "catch_clause",
      "finally_clause",
      "arrow_function",
      "function_expression",
    ],
    code: `export class Worker {
  run(items: string[], mode: number): number {
    let total = 0;
    if (mode > 1) {
      total += 1;
    } else if (mode < 0) {
      total -= 1;
    } else {
      total = 0;
    }
    for (let i = 0; i < items.length; i++) {
      total += items[i].length;
    }
    for (const item of items) {
      total += item.length;
    }
    while (total > 100) {
      total -= 10;
    }
    do {
      total += 1;
    } while (total < 5);
    switch (mode) {
      case 1:
        total += 1;
        break;
      default:
        total += 2;
    }
    try {
      total += JSON.parse("1");
    } catch (error) {
      total = -1;
    } finally {
      total += 0;
    }
    items.forEach((item) => {
      total += item.length;
    });
    const legacy = function (value: number) {
      return value + 1;
    };
    for (const big of items) {
${lines(BIG, (i) => `      total += big.length * ${i} + legacy(${i});`)}
    }
    return total;
  }
}
`,
  },

  javascript: {
    filePath: "src/worker.js",
    baseSymbolId: "Worker#run",
    bigLoopHeader: "for (const big of items) {",
    constructs: [
      "if_statement",
      "else_clause",
      "for_statement",
      "for_in_statement",
      "while_statement",
      "do_statement",
      "switch_statement",
      "try_statement",
      "catch_clause",
      "finally_clause",
      "arrow_function",
      "function_expression",
    ],
    code: `export class Worker {
  run(items, mode) {
    let total = 0;
    if (mode > 1) {
      total += 1;
    } else if (mode < 0) {
      total -= 1;
    } else {
      total = 0;
    }
    for (let i = 0; i < items.length; i++) {
      total += items[i].length;
    }
    for (const key in items) {
      total += key.length;
    }
    while (total > 100) {
      total -= 10;
    }
    do {
      total += 1;
    } while (total < 5);
    switch (mode) {
      case 1:
        total += 1;
        break;
      default:
        total += 2;
    }
    try {
      total += JSON.parse("1");
    } catch (error) {
      total = -1;
    } finally {
      total += 0;
    }
    items.forEach((item) => {
      total += item.length;
    });
    const legacy = function (value) {
      return value + 1;
    };
    for (const big of items) {
${lines(BIG, (i) => `      total += big.length * ${i} + legacy(${i});`)}
    }
    return total;
  }
}
`,
  },

  python: {
    filePath: "src/worker.py",
    baseSymbolId: "Worker#run",
    bigLoopHeader: "for big in items:",
    constructs: [
      "if_statement",
      "elif_clause",
      "else_clause",
      "for_statement",
      "while_statement",
      "try_statement",
      "except_clause",
      "finally_clause",
      "with_statement",
      "match_statement",
      "case_clause",
      "lambda",
      "list_comprehension",
    ],
    code: `class Worker:
    def run(self, items, mode):
        total = 0
        if mode > 1:
            total += 1
        elif mode < 0:
            total -= 1
        else:
            total = 0
        for item in items:
            total += len(item)
        while total > 100:
            total -= 10
        try:
            total += int("1")
        except ValueError:
            total = -1
        finally:
            total += 0
        with open("f") as handle:
            total += len(handle.read())
        match mode:
            case 1:
                total += 1
            case _:
                total += 2
        add = lambda x: (
            x + 1
        )
        squares = [
            x * x for x in items
        ]
        for big in items:
${lines(BIG, (i) => `            total += len(big) * ${i} + add(${i})`)}
        return total
`,
  },

  go: {
    filePath: "worker.go",
    baseSymbolId: "Run",
    bigLoopHeader: "for _, big := range items {",
    constructs: [
      "if_statement",
      "for_statement",
      "expression_switch_statement",
      "type_switch_statement",
      "select_statement",
      "go_statement",
      "defer_statement",
      "func_literal",
    ],
    code: `package main

func Run(items []string, mode int, ch chan int) int {
	total := 0
	if mode > 1 {
		total += 1
	} else if mode < 0 {
		total -= 1
	} else {
		total = 0
	}
	for i := 0; i < len(items); i++ {
		total += len(items[i])
	}
	for _, item := range items {
		total += len(item)
	}
	switch mode {
	case 1:
		total += 1
	default:
		total += 2
	}
	var value interface{} = mode
	switch v := value.(type) {
	case int:
		total += v
	}
	select {
	case n := <-ch:
		total += n
	default:
		total += 0
	}
	go func() {
		ch <- 1
	}()
	defer func() {
		total += 0
	}()
	for _, big := range items {
${lines(BIG, (i) => `		total += len(big) * ${i} + mode`)}
	}
	return total
}
`,
  },

  rust: {
    filePath: "src/worker.rs",
    baseSymbolId: "run",
    bigLoopHeader: "for big in items {",
    constructs: [
      "if_expression",
      "else_clause",
      "for_expression",
      "while_expression",
      "loop_expression",
      "match_expression",
      "match_arm",
      "closure_expression",
      "unsafe_block",
    ],
    code: `fn run(items: &[String], mode: i32) -> i32 {
    let mut total = 0;
    if mode > 1 {
        total += 1;
    } else if mode < 0 {
        total -= 1;
    } else {
        total = 0;
    }
    for item in items {
        total += item.len() as i32;
    }
    while total > 100 {
        total -= 10;
    }
    loop {
        total += 1;
        if total > 5 { break; }
    }
    match mode {
        1 => {
            total += 1;
        }
        _ => {
            total += 2;
        }
    }
    let add = |x: i32| {
        x + 1
    };
    unsafe {
        total += 0;
    }
    for big in items {
${lines(BIG, (i) => `        total += big.len() as i32 * ${i} + add(${i});`)}
    }
    total
}
`,
  },

  java: {
    filePath: "src/Worker.java",
    baseSymbolId: "Worker#run",
    bigLoopHeader: "for (String big : items) {",
    constructs: [
      "if_statement",
      "for_statement",
      "enhanced_for_statement",
      "while_statement",
      "do_statement",
      "switch_expression",
      "try_statement",
      "catch_clause",
      "finally_clause",
      "try_with_resources_statement",
      "synchronized_statement",
      "lambda_expression",
    ],
    code: `public class Worker {
    public int run(java.util.List<String> items, int mode) {
        int total = 0;
        if (mode > 1) {
            total += 1;
        } else if (mode < 0) {
            total -= 1;
        } else {
            total = 0;
        }
        for (int i = 0; i < items.size(); i++) {
            total += items.get(i).length();
        }
        for (String item : items) {
            total += item.length();
        }
        while (total > 100) {
            total -= 10;
        }
        do {
            total += 1;
        } while (total < 5);
        switch (mode) {
            case 1:
                total += 1;
                break;
            default:
                total += 2;
        }
        try {
            total += Integer.parseInt("1");
        } catch (NumberFormatException e) {
            total = -1;
        } finally {
            total += 0;
        }
        try (java.io.StringReader reader = new java.io.StringReader("x")) {
            total += reader.read();
        } catch (java.io.IOException e) {
            total = -2;
        }
        synchronized (this) {
            total += 1;
        }
        items.forEach(item -> {
            System.out.println(item);
        });
        for (String big : items) {
${lines(BIG, (i) => `            total += big.length() * ${i} + mode;`)}
        }
        return total;
    }
}
`,
  },

  ruby: {
    filePath: "lib/worker.rb",
    baseSymbolId: "Worker#run",
    bigLoopHeader: "items.each do |big|",
    constructs: [
      "if",
      "elsif",
      "else",
      "unless",
      "while",
      "until",
      "for",
      "case",
      "when",
      "begin",
      "rescue",
      "ensure",
      "do_block",
      "block",
      "lambda",
    ],
    code: `class Worker
  def run(items, mode)
    total = 0
    if mode > 1
      total += 1
    elsif mode < 0
      total -= 1
    else
      total = 0
    end
    unless items.empty?
      total += 1
    end
    while total > 100
      total -= 10
    end
    until total < 5
      total -= 1
    end
    for item in items
      total += item.size
    end
    case mode
    when 1
      total += 1
    else
      total += 2
    end
    begin
      total += Integer("1")
    rescue ArgumentError
      total = -1
    ensure
      total += 0
    end
    items.map { |item|
      item.size
    }
    handler = ->(x) do
      x + 1
    end
    items.each do |big|
${lines(BIG, (i) => `      total += big.size * ${i} + handler.call(${i})`)}
    end
    total
  rescue StandardError
    0
  ensure
    total
  end
end
`,
  },

  bash: {
    filePath: "scripts/worker.sh",
    baseSymbolId: "run_all",
    bigLoopHeader: 'for big in "$@"; do',
    constructs: [
      "if_statement",
      "elif_clause",
      "else_clause",
      "for_statement",
      "c_style_for_statement",
      "while_statement",
      "case_statement",
      "case_item",
      "subshell",
      "compound_statement",
    ],
    code: `run_all() {
  local total=0
  if [ "$1" -gt 1 ]; then
    total=1
  elif [ "$1" -lt 0 ]; then
    total=-1
  else
    total=0
  fi
  for item in "$@"; do
    total=$((total + 1))
  done
  for ((i = 0; i < 3; i++)); do
    total=$((total + i))
  done
  while [ "$total" -gt 100 ]; do
    total=$((total - 10))
  done
  until [ "$total" -lt 5 ]; do
    total=$((total - 1))
  done
  case "$1" in
    one)
      total=1
      ;;
    *)
      total=2
      ;;
  esac
  (
    cd /tmp || exit
    total=3
  )
  {
    echo "grouped"
    echo "$total"
  }
  for big in "$@"; do
${lines(BIG, (i) => `    total=$((total + \${#big} * ${i}))`)}
  done
  echo "$total"
}
`,
  },

  swift: {
    filePath: "Sources/Worker.swift",
    baseSymbolId: "Worker#run",
    bigLoopHeader: "for big in items {",
    constructs: [
      "if_statement",
      "guard_statement",
      "for_statement",
      "while_statement",
      "repeat_while_statement",
      "switch_statement",
      "switch_entry",
      "do_statement",
      "catch_block",
      "lambda_literal",
    ],
    code: `class Worker {
    func run(items: [String], mode: Int) throws -> Int {
        var total = 0
        if mode > 1 {
            total += 1
        } else if mode < 0 {
            total -= 1
        } else {
            total = 0
        }
        guard !items.isEmpty else {
            return 0
        }
        for item in items {
            total += item.count
        }
        while total > 100 {
            total -= 10
        }
        repeat {
            total += 1
        } while total < 5
        switch mode {
        case 1:
            total += 1
        default:
            total += 2
        }
        do {
            total += try parse("1")
        } catch {
            total = -1
        }
        defer {
            total += 0
        }
        items.forEach { item in
            total += item.count
        }
        let add = { (x: Int) -> Int in
            return x + 1
        }
        for big in items {
${lines(BIG, (i) => `            total += big.count * ${i} + add(${i})`)}
        }
        return total
    }
}
`,
  },
};
