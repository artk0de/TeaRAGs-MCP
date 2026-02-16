/** Phrases for the DinoRun easter egg — three outcome categories */

/** Outcome 1: Dinosaur catches the chicken — predator insights */
export const catchPhrases = [
  // Technical superiority
  "Caught you. Just like I catch bugs — with trajectory data. 🦖🍗",
  "Fastest predator in the Cretaceous. Fastest indexer in your monorepo.",
  "The chase lasted 5 seconds. Your last production bug lasted 3 sprints.",
  "I hunt with cosine similarity. The chicken didn't stand a chance.",
  "Predator instinct: find the target, close the distance, ship the feature.",
  "Caught you before your CI pipeline finished. Both times were slow.",
  "My catching algorithm: O(1). Your debugging: O(n²).",

  // Engineering condescension
  "I'm 65 million years old. You thought a chicken could outrun me? Cute.",
  "That chicken had the same chance as your regex in a code review.",
  "Survival of the fittest. In the codebase, that means lowest bugFixRate. Yours isn't.",
  "Dinner is served. Unlike your last deployment, this one was on time.",
  "The prey thought it could hide. But I have semantic search. You have grep. 🔍",
  "Caught it faster than you catch your own off-by-one errors.",
  "The chicken ran like your tests — fast but not fast enough.",
  "Some things never change. T-Rex hunts. Developers copy from Stack Overflow. Tea steeps. 🍵",

  // Dark engineering humor
  "Quick catch. Quicker than reverting a bad merge on Friday evening.",
  "The chicken's escape plan had the same quality as your error handling.",
  "Velocity matters. In code and in chicken chasing. You know about neither.",
  "I didn't evolve for nothing. Unlike that abstraction layer in your codebase.",
  "That chicken ran without a plan. Remind you of anyone? git push --force?",
  "One bite. One commit. Both should be atomic. Yours aren't.",
];

/** Outcome 2: Dinosaur falls into a pit — growth through failure */
export const pitPhrases = [
  // Technical humility
  "Fell in a hole. Happens to the best functions too. Check the trajectory. 🕳️",
  "ageDays: 65000000, pitFallRate: 100%. Even I have bad metrics.",
  "The pit was there all along. Like that bug in production. We both missed it.",
  "Down I go. At least I don't blame the compiler.",

  // Engineering wisdom
  "Even dinosaurs have bad deploys. The key is the rollback. Not the blame. 🦖",
  "Mistakes are just undocumented features of the learning process.",
  "Every fall teaches you where the ground isn't. Every 500 teaches you where the null isn't.",
  "Fell. Got up. Reindexed. That's the cycle. Your pipeline knows. 🔄",
  "The only failure is not getting back up. And not writing a regression test.",
  "Grace under pressure. Or at least tea under pressure. Your production server knows neither. 🍵",
  "commitCount: 1, outcome: pit. Next iteration will be better. Unlike your retry logic.",

  // Condescending empathy
  "A pit? I've survived an asteroid. You panicked when npm audit found 47 vulnerabilities.",
  "The chicken won this round. Like TypeScript wins against your 'any' types.",
  "I fell, but at least I fell forward. Unlike your last migration.",
  "The pit didn't have a warning sign. Neither did your deprecated dependency.",
  "You know what, at least I didn't console.log('here') to find this pit.",
  "Fell into a hole. Still more graceful than your exception handling.",
  "The ground gave way. Like your confidence when the senior reviews your PR.",
  "Plot twist: the pit was a feature, not a bug.",
  "Restarting. Unlike your service, I don't need a Docker container to get back up.",
  "At least my fall was deterministic. Your flaky tests can't say the same.",
];

/** Outcome 3: Chicken lays an egg — small progress */
export const eggPhrases = [
  // Philosophical progress
  "A small egg. A small commit. Progress is progress. 🥚",
  "Not every sprint ends with a feature. Sometimes you get an egg. Ship it.",
  "The chicken created something. Unlike your last standup, which created nothing.",
  "Tiny egg. Tiny step. Tiny commit. All journeys start small. Including your tech debt.",
  "An egg today, a pull request tomorrow. Growth takes time. So does your code review queue.",
  "Even the smallest function starts as a single line. Even the worst monolith started as a small egg.",

  // Technical observations
  "One egg at a time. One chunk at a time. One reindex at a time. Not 47 files in one commit.",
  "The chicken didn't build a monorepo overnight. Neither did you. Yours just feels like it. 🐔",
  "Small progress compounds. Like churn, but the good kind. Unlike your node_modules. 📈",
  "An egg! Life finds a way. So does well-structured code. Yours... also finds a way. Somehow.",
  "The chicken shipped an MVP. More than your last planning meeting produced.",
  "From one egg to a codebase. Everything grows if you let it. Especially technical debt.",

  // Condescending encouragement
  "One egg. One function. One test. You do write tests, right? ...right?",
  "The egg is small but it compiles. That's more than your last push.",
  "Baby steps. The chicken knows. You could learn from a chicken.",
  "An egg. Fragile. Like your production environment without health checks.",
  "The chicken produced output. That's already better than some microservices I've indexed.",
  "A small egg, but at least it has no circular dependencies.",
  "The egg has potential. Like your codebase. Except the egg might actually hatch.",
  "Small egg, big dreams. Like your startup's Kubernetes cluster for 3 users.",
  "Oooh, I still haven't figured out which came first. 🥚🐔",
];

/** Outcome 4: Robot chases the dinosaur away — vibe coding humor */
export const robotPhrases = [
  // Vibe coding absurdity
  "The robot said 'I'll handle it.' 3000 lines later, nobody knows what it does. Including the robot. 🤖",
  "Vibe coding: where 2 engineers create the tech debt of 50. That robot creates the debt of 500.",
  "The AI wrote code that works. Neither of us knows why. TeaRAGs indexed it anyway.",
  "Vibe debugging is the hard part. Especially when the code was vibe-coded by something faster than you.",
  "One vibe-coded commit. 47 new dependencies. Zero tests. I ran.",
  "Andrej said 'forget the code exists.' The robot took it literally. Now nobody can find it.",
  "console.log('here'). console.log('here2'). console.log('why'). The robot's debugging strategy.",

  // TeaRAGs + AI humor
  "$1000/hour to fix vibe-coded messes. The robot creates them for free. TeaRAGs indexes them forever.",
  "That robot vibe-coded a security vulnerability in 0.3 seconds. Your team would've taken a whole sprint.",
  "Plot twist: the robot was just a wrapper around TeaRAGs with extra console.logs.",
  "The robot doesn't grep. Doesn't need semantic search. Just generates. And generates. And generates.",
  "I survived 65 million years. I will not survive vibe-coded infrastructure. 🦖💨",
  "The robot doesn't read docs. Doesn't need docs. IS the docs. Unfortunately.",

  // Running away humor
  "The AI is chasing me. Just like it's chasing your job. We're both running.",
  "I've outrun asteroids, mass extinction, and legacy Java. But a robot with GPT? I'm out.",
  "Even a T-Rex knows when to retreat. Vibe-coded prod deploy on Friday? RUN.",
  "My code has survived an asteroid. It won't survive 'just let the AI refactor it.'",
  "Retreat is not defeat. It's a strategic revert. git checkout -- life.",
  "The robot promised 10x velocity. The codebase got 10x entropy. I got 10x anxiety.",
];
