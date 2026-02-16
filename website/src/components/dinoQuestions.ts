const dinoQuestions = [
  // --- 1. Visual: power + calm ---
  "Strong enough to index millions of lines. Calm enough to drink tea. 🍵",
  "Big tools don't need to be loud.",
  "The mightiest creatures know when to sit still.",
  "Power is not in speed. It's in knowing where to look.",
  "Even a T-Rex needs a break between reindexes. 🦖",
  "Brew tea. Index code. Repeat.",

  // --- 2. Developer metaphor: survivor ---
  "I survived jQuery, Angular 1, and callback hell. Semantic search is easy.",
  "Old enough to remember SVN. Wise enough to use git signals.",
  "Not extinct. Adapted.",
  "Some call it legacy. I call it battle-tested.",
  "I've seen frameworks come and go. The code stays.",
  "Senior developers don't grep faster. They ask better questions.",
  "Every rewrite teaches you what not to rewrite next time.",
  "The best code review is the one git history already wrote.",

  // --- 3. AI era: human becomes strategist ---
  "The agent writes code. You drink tea and review. That's the deal. 🍵",
  "You're not replaced. You're promoted to strategist.",
  "Let the agent search. You make the decisions.",
  "The dinosaur doesn't type anymore. He thinks.",
  "AI writes. You direct. The tea keeps you patient. 🦖",
  "Your job isn't to write code. It's to know which code is right.",
  "The agent found 20 results. Trajectory enrichment tells you which 3 matter.",
  "Coding agents are fast. Wise agents are accurate.",

  // --- 4. Engineering philosophy: control through tools ---
  "Confidence comes from understanding your system, not from typing speed.",
  "The calm developer ships fewer bugs.",
  "Automation works for you, not instead of you.",
  "You don't need to read every file. You need to find the right one.",
  "The best optimization is knowing what not to touch.",
  "Measure twice, rerank once.",
  "If you can't explain why this code exists, check the taskIds.",
  "A stable codebase isn't one that never changes. It's one that changes with purpose.",

  // --- 5. Evolution of development ---
  "The dinosaur didn't go extinct. He learned to use tools. 🦖",
  "Code evolves. Developers evolve with it. Or they don't.",
  "Yesterday's patterns are today's anti-patterns. Check the churn.",
  "Every function has a life story. TeaRAGs reads it for you.",
  "Evolution favors those who adapt. Not those who rewrite.",
  "Your codebase isn't static. It's a living system with a trajectory.",
  "The code you wrote 6 months ago is a different species now.",
  "Software doesn't fossilize. It churns.",

  // --- 6. Trajectory / time ---
  "Not just code as it is. Code as it became. 🧠",
  "Every commit is a fossil layer. TeaRAGs is the archaeologist.",
  "History doesn't repeat, but bugFixRate does.",
  "The trajectory of code tells you more than the code itself.",
  "One function, 47 commits, 3 authors. That's a story worth reading.",
  "Time is the best code reviewer. I just read its notes.",
  "Code without history is a stranger. Code with trajectory is a colleague.",
  "ageDays: 180, commitCount: 2, bugFixRate: 0%. That's trust.",
  "ageDays: 14, commitCount: 12, bugFixRate: 60%. That's a warning. 🚩",
  "The path matters more than the destination. Especially in code.",

  // --- 7. Brand: friendly outside, deep inside ---
  "I look like a toy. I think like an engineer.",
  "Cute logo. Serious infrastructure.",
  "Don't let the tea fool you. There's a vector database behind this smile.",
  "Approachable outside. 19 git signals inside.",
  "I'm the friendliest enterprise tool you'll ever meet. 🦖",

  // --- 8. Irony and self-awareness ---
  "Small arms, big insights. 🦖",
  "I can't clap, but I can rerank your search results.",
  "Yes, I'm a dinosaur using machine learning. The future is weird.",
  "90% of the naming budget went into making this typeable with one hand.",
  "I drink tea and judge your commit history. No offense. 🍵",
  "My arms are short but my embeddings are dense.",
  "I'm technically a dinosaur. But my index is always up to date.",
  "Extinct? I've been reindexed. Big difference.",

  // --- 9. Hidden narrative: engineer in control ---
  "The experienced developer doesn't fight the code anymore. He directs intelligence.",
  "You're not debugging. You're observing the trajectory.",
  "The code doesn't scare you. You have data.",
  "Somewhere, a developer is calmly sipping tea while their agent refactors a monorepo.",
  "This is what engineering maturity looks like: knowing, not guessing.",
  "When the system works for you, you can finally think.",

  // --- Philosophy of life ---
  "The best search query is the one you don't have to repeat.",
  "Patience is a feature, not a bug.",
  "Sometimes the fastest solution is to slow down and search by intent.",
  "You can grep your way through life. Or you can ask what it means.",
  "Code, like life, makes more sense when you look at the trajectory.",
  "The tea is a metaphor. The dinosaur is a lifestyle.",
  "Work smarter, not grepper.",
  "What if the code you're about to copy has a 60% bug-fix rate? Now you know.",
  "The answer is in the history. It always was.",

  // --- Community & contribution ---
  "Know what makes a dinosaur smile? A GitHub star. ⭐",
  "This tooltip was built with love. PRs make it better. 💚",
  "You found a hidden tooltip! That deserves a star. ⭐",
  "Open source thrives on contributors. And tea. Mostly tea. 🍵",
  "Every star on GitHub warms a dinosaur's cold-blooded heart. ⭐🦖",
  "Found a bug? Open an issue. Found it useful? Star the repo. 🌟",
  "Contributors get their name in CONTRIBUTORS.md. And the dinosaur's respect.",
  "The best way to improve TeaRAGs? Use it, break it, fix it, PR it.",
  "If this tooltip made you smile, imagine what the tool can do. ⭐",
  "One small star for a developer, one giant leap for a dinosaur. 🦖⭐",

  // --- 10. Vibe coding era ---
  "Vibe coding is not laziness. It's delegation with taste. 🎯",
  "The dinosaur doesn't vibe-code. He vibe-architects.",
  "Type less. Think more. Sip tea. Ship code. 🍵",
  "Your agent writes 500 lines. TeaRAGs tells you which 20 matter.",
  "The future of coding: describe intent, review results, drink tea.",
  "Vibe check: is this function stable? commitCount: 2, bugFixRate: 0%. Vibes are good. ✅",
  "The vibes say refactor. The trajectory says don't touch it.",
  "Vibe coding without semantic search is just vibes. Add the search. 🔍",
  "Some call it vibe coding. I call it engineering with better tools.",
  "The vibe is local-first, privacy-first, tea-first. 🍵",

  // --- 11. Tea ceremony ---
  "Green tea for refactoring. Black tea for debugging. Chamomile for prod incidents. 🍵",
  "A watched kettle never boils. A watched build always fails.",
  "The tea is not a metaphor. I literally drink tea. The metaphor is the dinosaur. 🦖",
  "Steep time matters. In tea and in code review.",
  "One does not simply grep a monorepo. One sips and searches semantically.",
  "The perfect cup takes patience. So does the perfect query.",
  "Pu-erh gets better with age. So does well-maintained code.",
  "Earl Grey: the choice of dinosaurs who've earned their calm.",
  "Tea leaves unfurl slowly. So should your understanding of a new codebase.",

  // --- 12. Developer daily life ---
  "'It works on my machine' — famous last words before the trajectory analysis. 🔥",
  "I indexed your monorepo while you were arguing about tabs vs spaces.",
  "Friday deploy? Check the bugFixRate first. Trust me on this one.",
  "Somewhere a CI pipeline is green. Savor that feeling. 💚",
  "The PR has 47 comments. The trajectory says it all in 3 signals.",
  "You renamed the variable. The trajectory remembers the old name.",
  "'Just a small refactor' — said no trajectory analysis ever.",
  "Stack Overflow taught you how. Trajectory tells you whether you should.",

  // --- 13. The dinosaur's personality ---
  "Sometimes I just sit here, watching embeddings converge. It's peaceful. 🧘",
  "My therapist says I have too many dimensions. I said: at least 384.",
  "People ask why a dinosaur. I ask why not. 🦖",
  "I'm 65 million years old. I've seen worse codebases.",
  "Short arms, long memory. That's the TeaRAGs advantage.",
  "They said dinosaurs can't code. They were right. I build infrastructure.",
  "My morning routine: wake up, index, brew tea, rerank. In that order.",
  "I don't have opposable thumbs. I have opposable vectors.",
  "65 million years of evolution and I ended up parsing ASTs. No regrets.",

  // --- 14. Technical depth ---
  "19 signals per chunk. Each one earned, not assumed.",
  "Embeddings capture what code means. Trajectory captures what code became.",
  "Your function is 47 lines. It has 12 commits, 3 authors, and a story.",
  "Cosine similarity finds what's close. Trajectory enrichment finds what's right.",
  "The vector knows the meaning. The git history knows the truth.",
  "384 dimensions per embedding. And you thought your project was complex. 🧮",
  "git blame told you who. Trajectory tells you why.",
  "Qdrant stores vectors. Git stores wisdom. TeaRAGs reads both. 🧠",
  "tree-sitter sees structure. Embeddings see meaning. Together: understanding.",
  "BM25 for keywords. Cosine for semantics. Trajectory for judgment.",

  // --- 15. Indie / local-first / privacy ---
  "No telemetry. No cloud. No subscription. Just code and tea. 🍵",
  "Local-first means your code never leaves your machine. Neither does the tea.",
  "Built by developers who got tired of grepping the same monorepo twice.",
  "Enterprise features. Indie spirit. Dinosaur energy. 🦖",
  "Your code. Your machine. Your tea. Your rules.",
  "Privacy isn't a feature. It's a principle. Like drinking tea.",
  "Cloud-free since the Cretaceous. ☁️🚫",

  // --- 16. Absurdist / Gen-Z energy ---
  "This dinosaur runs on tea and spite. Mostly tea.",
  "The code is mid. The trajectory confirms it. 📊",
  "No cap — 19 git signals per chunk is unhinged in the best way.",
  "POV: you're a function with a 60% bugFixRate and the dinosaur is looking at you. 👀",
  "It's giving... enterprise-grade semantic search with a dinosaur mascot.",
  "Me: *peacefully indexing 3.5M lines* Also me: *existential crisis about variable names*",
  "Slay (your technical debt). 💅",
  "The algorithm understood your code better than the person who wrote it. And that's tea. 🍵",
  "Main character energy, but for your codebase.",
  "Not me reranking search results at 3 AM. Okay, maybe me. 🌙",
];

export default dinoQuestions;
