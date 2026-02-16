import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { catchPhrases, eggPhrases, pitPhrases, robotPhrases } from "./dinoRunPhrases";
import {
  djb2,
  drawFromBag,
  loadBag,
  loadNextAt,
  loadSeenHashes,
  pickUniquePhrase,
  saveBag,
  saveNextAt,
  saveSeenHash,
  type Outcome,
} from "./dinoRunStorage";

const MIN_DELAY_MS = 5 * 60 * 1000; // 5 min (first spawn)
const MAX_DELAY_MS = 60 * 60 * 1000; // 60 min

const RUN_DURATION_MS = 5000;
const SENTENCE_DELAY_MS = 2500; // 2.5s per sentence
const READ_TIME_AFTER_LAST_MS = 3000; // 3s after last sentence
const MIN_DISPLAY_MS = 10000; // 10s total display time for any phrase

function getPhrase(outcome: Outcome): { phrase: string; hash: string } {
  const phrases = { catch: catchPhrases, pit: pitPhrases, egg: eggPhrases, robot: robotPhrases }[outcome];
  const seen = loadSeenHashes();
  const phrase = pickUniquePhrase(phrases, seen[outcome]);
  const hash = djb2(phrase);
  return { phrase, hash };
}

/** Split a phrase into sentences, preserving delimiters.
 *  Trailing emoji-only segments are merged with the previous sentence. */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+[\s]?|[^.!?]+$/g);
  if (!parts) return [text];
  const cleaned = parts.map((s) => s.trim()).filter(Boolean);
  // If the last segment has no alphanumeric chars (just emoji/symbols), merge it back
  if (cleaned.length > 1) {
    const last = cleaned[cleaned.length - 1];
    if (!/[a-zA-Z0-9\u0400-\u04FF]/.test(last)) {
      cleaned[cleaned.length - 2] += " " + last;
      cleaned.pop();
    }
  }
  return cleaned;
}

/** Where the dino ends up (% from left), used to position the comic bubble */
function finalDinoPercent(outcome: Outcome): number {
  switch (outcome) {
    case "pit":
      return 61; // dino stops at the pit
    case "catch":
      return Math.round(CATCH_DINO_STOP); // dino stops at bang point
    case "egg":
      return Math.round(EGG_POS - 2); // dino stops right before the egg
    case "robot":
      return 50; // bubble appears center-ish after both exit left
  }
}

interface AnimState {
  phase: "running" | "result";
  outcome: Outcome;
  phrase: string;
  sentences: string[];
  progress: number;
}

/* ── Typewriter: reveals sentences one by one ── */

function TypewriterText({ sentences, onAllRevealed }: { sentences: string[]; onAllRevealed: () => void }) {
  const [visibleCount, setVisibleCount] = useState(1);
  const revealedRef = useRef(false);

  useEffect(() => {
    if (sentences.length <= 1) {
      // Single sentence — show for at least MIN_DISPLAY_MS total
      revealedRef.current = true;
      const delay = Math.max(0, MIN_DISPLAY_MS - READ_TIME_AFTER_LAST_MS);
      const timeout = setTimeout(onAllRevealed, delay);
      return () => clearTimeout(timeout);
    }

    let i = 1;
    const timer = setInterval(() => {
      i++;
      setVisibleCount(i);
      if (i >= sentences.length) {
        clearInterval(timer);
        if (!revealedRef.current) {
          revealedRef.current = true;
          onAllRevealed();
        }
      }
    }, SENTENCE_DELAY_MS);

    return () => clearInterval(timer);
  }, [sentences, onAllRevealed]);

  return (
    <>
      {sentences.slice(0, visibleCount).map((s, idx) => (
        <span
          key={idx}
          style={{
            display: "inline",
            animation: idx > 0 ? "drun-sentenceIn 0.4s ease-out" : undefined,
          }}
        >
          {idx > 0 ? " " : ""}
          {s}
        </span>
      ))}
    </>
  );
}

/* ── Comic speech bubble with tail ── */

const BUBBLE_STYLE: React.CSSProperties = {
  background: "rgba(27, 27, 29, 0.94)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  border: "1px solid rgba(197, 168, 100, 0.25)",
  borderRadius: "1rem",
  padding: "14px 22px",
  boxShadow: "0 8px 32px rgba(0,0,0,0.35), 0 0 0 1px rgba(197,168,100,0.06)",
  maxWidth: "360px",
  minWidth: "180px",
  textAlign: "center" as const,
  fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
};

const TEXT_STYLE: React.CSSProperties = {
  color: "#e8e0d0",
  fontSize: "13px",
  fontWeight: 500,
  lineHeight: 1.55,
  letterSpacing: "-0.01em",
};

/** SVG tail pointing down toward the character.
 *  `offsetLeft` positions the tail precisely (px from container left). */
function BubbleTail({ flip, offsetLeft }: { flip?: boolean; offsetLeft?: number }) {
  return (
    <svg
      width="20"
      height="12"
      viewBox="0 0 20 12"
      style={{
        display: "block",
        ...(offsetLeft != null
          ? { marginLeft: `${offsetLeft}px` }
          : {
              marginLeft: flip ? "auto" : "24px",
              marginRight: flip ? "24px" : undefined,
            }),
        transform: flip ? "scaleX(-1)" : undefined,
      }}
    >
      <path
        d="M0 0 C4 0, 8 4, 4 12 C4 12, 12 4, 20 0 Z"
        fill="rgba(27, 27, 29, 0.94)"
        stroke="rgba(197, 168, 100, 0.25)"
        strokeWidth="1"
      />
      {/* Cover the top border line where tail meets bubble */}
      <rect x="0" y="0" width="20" height="2" fill="rgba(27, 27, 29, 0.94)" />
    </svg>
  );
}

/* ── Chicken trigger button ── */

function ChickenButton({ onClick }: { onClick: () => void }) {
  return createPortal(
    <button
      onClick={onClick}
      aria-label="Start dinosaur animation"
      style={{
        position: "fixed",
        bottom: "16px",
        left: "16px",
        zIndex: 99990,
        background: "none",
        border: "none",
        fontSize: "32px",
        cursor: "pointer",
        padding: "4px",
        lineHeight: 1,
        animation: "drun-chickenAppear 0.6s ease-out",
        filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.3))",
        transition: "transform 0.2s ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.2)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
    >
      🐔
    </button>,
    document.body,
  );
}

/* ── Main component ── */

export default function DinoRun() {
  const [state, setState] = useState<AnimState | null>(null);
  const [chickenReady, setChickenReady] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const rafRef = useRef<number>(0);
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    const nextAt = Date.now() + delay;
    saveNextAt(nextAt);
    timerRef.current = setTimeout(() => setChickenReady(true), delay);
  }, []);

  const dismiss = useCallback(() => {
    runningRef.current = false;
    setState(null);
    scheduleNext();
  }, [scheduleNext]);

  const startRun = useCallback(
    (forcedOutcome?: Outcome) => {
      // Animation is non-cancellable — ignore all triggers while running
      if (runningRef.current) return;
      runningRef.current = true;

      // Hide chicken button if showing
      setChickenReady(false);

      // Cancel pending schedule timer
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      let outcome: Outcome;
      if (forcedOutcome) {
        outcome = forcedOutcome;
      } else {
        const bag = loadBag();
        const draw = drawFromBag(bag);
        outcome = draw.outcome;
        saveBag(draw.remaining);
      }
      const { phrase, hash } = getPhrase(outcome);
      saveSeenHash(outcome, hash);
      const sentences = splitSentences(phrase);

      // Small delay to reset state, then start animation
      requestAnimationFrame(() => {
        setState({ phase: "running", outcome, phrase, sentences, progress: 0 });

        const t0 = Date.now(); // Start timing AFTER state reset
        const baseDuration = outcome === "robot" ? 6000 : RUN_DURATION_MS;
        let robotExitTime = 0;

        const tick = () => {
          const elapsed = Date.now() - t0;
          let p: number;

          if (outcome === "robot") {
            // After the dino turns, progress runs at 3x slower (watchable chase)
            const turnTime = DINO_TURN_P * baseDuration;
            if (elapsed <= turnTime) {
              p = elapsed / baseDuration;
            } else {
              const postDuration = (1 - DINO_TURN_P) * baseDuration * 5;
              p = DINO_TURN_P + (1 - DINO_TURN_P) * Math.min(1, (elapsed - turnTime) / postDuration);
            }
          } else {
            p = Math.min(1, elapsed / baseDuration);
          }

          setState((prev) => (prev ? { ...prev, progress: p } : null));

          if (p >= 1) {
            // Robot: wait 1s after exit before showing bubble
            if (outcome === "robot") {
              if (!robotExitTime) robotExitTime = Date.now();
              if (Date.now() - robotExitTime < 1000) {
                rafRef.current = requestAnimationFrame(tick);
                return;
              }
            }
            resultStartRef.current = Date.now();
            setState((prev) => (prev ? { ...prev, phase: "result" } : null));
          } else {
            rafRef.current = requestAnimationFrame(tick);
          }
        };
        rafRef.current = requestAnimationFrame(tick);
      });
    },
    [scheduleNext],
  );

  const resultStartRef = useRef<number>(0);

  const handleAllRevealed = useCallback(() => {
    if (dismissRef.current) clearTimeout(dismissRef.current);
    // Ensure at least MIN_DISPLAY_MS from when the result phase started
    const elapsed = Date.now() - resultStartRef.current;
    const remaining = Math.max(READ_TIME_AFTER_LAST_MS, MIN_DISPLAY_MS - elapsed);
    dismissRef.current = setTimeout(dismiss, remaining);
  }, [dismiss]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const dinoParam = params.get("dinorun");

    // ?dinorun=true|catch|pit|egg|button — test mode, dev only
    if (dinoParam && process.env.NODE_ENV === "development") {
      if (dinoParam === "button") {
        // Test mode: show chicken button immediately
        setChickenReady(true);
        return;
      }
      const forced =
        dinoParam === "catch" || dinoParam === "pit" || dinoParam === "egg" || dinoParam === "robot"
          ? (dinoParam as Outcome)
          : undefined;
      setTimeout(() => startRun(forced), 1500);
      return;
    }

    // Never auto-schedule on main page (/ or /baseUrl/)
    const isMainPage = /^\/[^/]*\/?$/.test(window.location.pathname);
    if (!isMainPage) {
      const savedNextAt = loadNextAt();
      const now = Date.now();
      if (savedNextAt > 0 && savedNextAt <= now) {
        setChickenReady(true); // Timer already expired — show chicken immediately
      } else if (savedNextAt > now) {
        timerRef.current = setTimeout(() => setChickenReady(true), savedNextAt - now);
      } else {
        scheduleNext(); // No saved timer — start fresh
      }
    }

    // Logo click triggers dino run
    const handleLogoTrigger = () => startRun();
    window.addEventListener("dinorun-trigger", handleLogoTrigger);

    return () => {
      window.removeEventListener("dinorun-trigger", handleLogoTrigger);
      if (timerRef.current) clearTimeout(timerRef.current);
      cancelAnimationFrame(rafRef.current);
      if (dismissRef.current) clearTimeout(dismissRef.current);
    };
  }, [startRun, scheduleNext]);

  if (typeof document === "undefined") return null;

  if (!state && chickenReady) {
    return (
      <ChickenButton
        onClick={() => {
          setChickenReady(false);
          startRun();
        }}
      />
    );
  }

  if (!state) return null;

  return createPortal(<DinoRunOverlay state={state} onAllRevealed={handleAllRevealed} />, document.body);
}

/* ── Overlay: running strip + comic bubble result ── */

function DinoRunOverlay({ state, onAllRevealed }: { state: AnimState; onAllRevealed: () => void }) {
  const { phase, outcome, progress, sentences } = state;

  // Compute tail offsets so they always point at the character
  const pitBubbleRef = useRef<HTMLDivElement>(null);
  // egg/catch bubble offsets computed statically (drun-bubbleIn scale skews getBoundingClientRect)
  const [pitTailOffset, setPitTailOffset] = useState(30);
  const [eggTailOffset, setEggTailOffset] = useState(30);
  const [catchTailOffset, setCatchTailOffset] = useState(30);
  useEffect(() => {
    if (phase !== "result") return;
    // SVG tip is at x=4 inside the 20px-wide SVG
    if (outcome === "pit" && pitBubbleRef.current) {
      const rect = pitBubbleRef.current.getBoundingClientRect();
      const pitX = window.innerWidth * 0.61 + 8;
      setPitTailOffset(Math.max(8, pitX - rect.left - 4));
    }
    if (outcome === "egg") {
      // Compute statically — drun-bubbleIn uses scale(0.92) which skews rect
      const vw = window.innerWidth;
      const dinoCenter = (vw * (EGG_POS - 0.5)) / 100 + 13;
      const bubbleFinalLeft = Math.max(10, Math.min(vw * ((EGG_POS - 0.5) / 100) - 34, vw - 380));
      setEggTailOffset(Math.max(8, dinoCenter - bubbleFinalLeft - 4));
    }
    if (outcome === "catch") {
      // Compute statically — can't use getBoundingClientRect because
      // drun-bubbleIn starts with scale(0.92) which skews the rect.
      const vw = window.innerWidth;
      const dinoCenter = vw * (CATCH_DINO_STOP / 100) + 13;
      const pct = finalDinoPercent("catch");
      const bubbleFinalLeft = Math.max(10, Math.min(vw * (pct / 100) - 80, vw - 380));
      setCatchTailOffset(Math.max(8, dinoCenter - bubbleFinalLeft - 4));
    }
  }, [phase, outcome]);

  // Dust cloud AFTER dino has fully disappeared (opacity hits 0 at ~0.89)
  const showDust = outcome === "pit" && progress > 0.88 && progress < 0.99;
  const dustOpacity = showDust
    ? progress < 0.92
      ? (progress - 0.88) * 16 // fade in
      : Math.max(0, 1 - (progress - 0.92) * 14) // fade out
    : 0;

  // Where to anchor the comic bubble (% from left edge)
  const bubbleLeftPct = finalDinoPercent(outcome);
  // Clamp so bubble doesn't overflow viewport
  const bubbleLeft = `clamp(10px, calc(${bubbleLeftPct}% - 80px), calc(100vw - 380px))`;

  return (
    <>
      <style>{`
        @keyframes drun-slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes drun-bubbleIn {
          from { opacity: 0; transform: translateY(10px) scale(0.92); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes drun-fromPit {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes drun-bounce {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-6px); }
        }
        @keyframes drun-dustPuff {
          0%   { transform: scale(0.5) translateY(0); opacity: 0; }
          30%  { transform: scale(1.2) translateY(-8px); opacity: 1; }
          100% { transform: scale(1.8) translateY(-18px); opacity: 0; }
        }
        @keyframes drun-sentenceIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes drun-robotHop {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-6px); }
        }
        @keyframes drun-bang {
          0%   { transform: scale(0.3); opacity: 1; }
          40%  { transform: scale(1.6); opacity: 1; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes drun-poopArc {
          0%   { transform: translate(0, 0) rotate(0deg); opacity: 1; }
          25%  { transform: translate(60px, -70px) rotate(150deg); opacity: 1; }
          50%  { transform: translate(120px, -50px) rotate(300deg); opacity: 0.9; }
          75%  { transform: translate(165px, 40px) rotate(450deg); opacity: 0.5; }
          100% { transform: translate(200px, 200px) rotate(600deg); opacity: 0; }
        }
        @keyframes drun-chickenAppear {
          0%   { opacity: 0; transform: translateY(20px) scale(0.5); }
          60%  { opacity: 1; transform: translateY(-4px) scale(1.05); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>

      {/* ── Pit: single fixed element, independent of phases — never shifts ── */}
      {outcome === "pit" && (phase === "result" || progress > PIT_APPEAR_P) && (
        <span
          style={{
            position: "fixed",
            bottom: "4px",
            left: "61%",
            fontSize: "16px",
            lineHeight: 1,
            zIndex: 99999,
            pointerEvents: "none",
            opacity: phase === "result" ? 1 : Math.min(1, (progress - PIT_APPEAR_P) * 40),
          }}
        >
          🕳️
        </span>
      )}

      {/* ── Poop: flung right in an arc, falls off-screen (robot only) ── */}
      {outcome === "robot" && progress > DINO_TURN_P && (
        <span
          style={{
            position: "fixed",
            bottom: "12px",
            left: `${DINO_TURN_POS}%`,
            fontSize: "20px",
            lineHeight: 1,
            zIndex: 99999,
            pointerEvents: "none",
            animation: "drun-poopArc 1s linear forwards",
            willChange: "transform, opacity",
          }}
        >
          💩
        </span>
      )}

      {/* ── Running phase: full-width strip ── */}
      {phase === "running" && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            height: "48px",
            zIndex: 99998,
            background: "linear-gradient(to top, rgba(27,27,29,0.85) 0%, rgba(27,27,29,0) 100%)",
            pointerEvents: "none",
            animation: "drun-slideUp 0.5s cubic-bezier(0.4,0,0.2,1)",
          }}
        >
          {/* Ground line */}
          <div
            style={{
              position: "absolute",
              bottom: "10px",
              left: 0,
              right: 0,
              height: "1.5px",
              background: "rgba(197, 168, 100, 0.25)",
            }}
          />

          {/* Dust clouds — clustered tight around the pit at 61% */}
          {showDust && (
            <>
              <span
                style={{
                  position: "absolute",
                  bottom: "14px",
                  left: "60.5%",
                  fontSize: "18px",
                  opacity: dustOpacity,
                  animation: "drun-dustPuff 0.6s ease-out forwards",
                }}
              >
                💨
              </span>
              <span
                style={{
                  position: "absolute",
                  bottom: "18px",
                  left: "62%",
                  fontSize: "14px",
                  opacity: dustOpacity * 0.7,
                  animation: "drun-dustPuff 0.8s ease-out 0.1s forwards",
                }}
              >
                💨
              </span>
              <span
                style={{
                  position: "absolute",
                  bottom: "12px",
                  left: "59.5%",
                  fontSize: "12px",
                  opacity: dustOpacity * 0.5,
                  animation: "drun-dustPuff 0.7s ease-out 0.2s forwards",
                }}
              >
                💨
              </span>
            </>
          )}

          {/* Egg — stays at drop spot */}
          {outcome === "egg" && progress > EGG_DROP_P && (
            <span
              style={{
                position: "absolute",
                bottom: "12px",
                left: `${EGG_POS}%`,
                fontSize: "14px",
                animation: "drun-bounce 0.6s ease-in-out infinite",
              }}
            >
              🥚
            </span>
          )}

          {/* Chicken — disappears on catch bang or robot zap; rendered BEHIND dino */}
          {!(outcome === "robot" && progress > ROBOT_ZAP_P) && !(outcome === "catch" && progress > CATCH_BANG_P) && (
            <span
              style={{
                position: "absolute",
                bottom: chickenBottom(outcome, progress),
                left: `${chickenLeft(outcome, progress)}%`,
                fontSize: "20px",
                transform: "scaleX(-1)",
                zIndex: 1,
                willChange: "transform, left, bottom",
              }}
            >
              🐔
            </span>
          )}

          {/* Dinosaur — always rendered on top of chicken */}
          <span
            style={{
              position: "absolute",
              bottom: dinoBottom(outcome, progress),
              left: `${dinoLeft(outcome, progress)}%`,
              fontSize: "26px",
              transform: `scaleX(${dinoScaleX(outcome, progress)})`,
              opacity: dinoOpacity(outcome, progress),
              zIndex: 2,
              willChange: "transform, left, bottom, opacity",
            }}
          >
            🦖
          </span>

          {/* 💥 Bang — catch: dino catches chicken */}
          {outcome === "catch" && progress > CATCH_BANG_P && (
            <span
              style={{
                position: "absolute",
                bottom: "6px",
                left: `${chickenLeft("catch", CATCH_BANG_P)}%`,
                fontSize: "32px",
                animation: "drun-bang 0.3s ease-out forwards",
                zIndex: 3,
                pointerEvents: "none",
              }}
            >
              💥
            </span>
          )}

          {/* Drumstick — appears after catch bang */}
          {outcome === "catch" && progress > CATCH_BANG_P && (
            <span
              style={{
                position: "absolute",
                bottom: "12px",
                left: `${chickenLeft("catch", CATCH_BANG_P)}%`,
                fontSize: "16px",
              }}
            >
              🍗
            </span>
          )}

          {/* 💥 Bang — robot zaps chicken */}
          {outcome === "robot" && progress > ROBOT_ZAP_P && (
            <span
              style={{
                position: "absolute",
                bottom: "6px",
                left: `${ROBOT_ZAP_POS}%`,
                fontSize: "32px",
                animation: "drun-bang 0.3s ease-out forwards",
                zIndex: 3,
                pointerEvents: "none",
              }}
            >
              💥
            </span>
          )}

          {/* Drumstick + fire — appears where chicken was zapped by robot */}
          {outcome === "robot" && progress > ROBOT_ZAP_P && (
            <span
              style={{
                position: "absolute",
                bottom: "12px",
                left: `${ROBOT_ZAP_POS}%`,
                fontSize: "16px",
                opacity: Math.max(0, 1 - Math.max(0, progress - 0.97) * 25),
              }}
            >
              🍗🔥
            </span>
          )}

          {/* Robot — bounces in from right (CSS animation for constant bounce) */}
          {outcome === "robot" && progress > ROBOT_APPEAR_P - 0.01 && (
            <span
              style={{
                position: "absolute",
                bottom: "12px",
                left: `${robotLeft(progress)}%`,
                fontSize: "26px",
                animation: "drun-robotHop 0.3s ease-in-out infinite",
              }}
            >
              🤖
            </span>
          )}
        </div>
      )}

      {/* ── Result: pit — ground strip + bubble above ── */}
      {phase === "result" && outcome === "pit" && (
        <>
          {/* Ground strip — keeps everything outside page text */}
          <div
            style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              height: "48px",
              zIndex: 99997,
              background: "linear-gradient(to top, rgba(27,27,29,0.85) 0%, rgba(27,27,29,0) 100%)",
              pointerEvents: "none",
            }}
          >
            {/* Ground line */}
            <div
              style={{
                position: "absolute",
                bottom: "10px",
                left: 0,
                right: 0,
                height: "1.5px",
                background: "rgba(197, 168, 100, 0.25)",
              }}
            />
          </div>
          {/* Speech bubble — tail points at the pit */}
          <div
            ref={pitBubbleRef}
            style={{
              position: "fixed",
              bottom: "32px",
              left: `clamp(10px, calc(61% - 34px), calc(100vw - 380px))`,
              zIndex: 99998,
              pointerEvents: "none",
              animation: "drun-fromPit 0.5s cubic-bezier(0.4,0,0.2,1)",
            }}
          >
            <div style={BUBBLE_STYLE}>
              <div
                style={{
                  fontSize: "10px",
                  color: "rgba(197, 168, 100, 0.5)",
                  marginBottom: "6px",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                * muffled from the pit *
              </div>
              <div style={{ ...TEXT_STYLE, fontStyle: "italic" }}>
                <TypewriterText sentences={sentences} onAllRevealed={onAllRevealed} />
              </div>
            </div>
            <BubbleTail offsetLeft={pitTailOffset} />
          </div>
        </>
      )}

      {phase === "result" && outcome === "catch" && (
        <>
          {/* Ground strip */}
          <div
            style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              height: "48px",
              zIndex: 99997,
              background: "linear-gradient(to top, rgba(27,27,29,0.85) 0%, rgba(27,27,29,0) 100%)",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                bottom: "10px",
                left: 0,
                right: 0,
                height: "1.5px",
                background: "rgba(197, 168, 100, 0.25)",
              }}
            />
            {/* Dino — at exact running stop position */}
            <span
              style={{
                position: "absolute",
                bottom: "12px",
                left: `${CATCH_DINO_STOP}%`,
                fontSize: "26px",
                transform: "scaleX(-1)",
              }}
            >
              🦖
            </span>
            {/* Drumstick — at chicken's last position (where bang happened) */}
            <span
              style={{
                position: "absolute",
                bottom: "12px",
                left: `${chickenLeft("catch", CATCH_BANG_P)}%`,
                fontSize: "16px",
              }}
            >
              🍗
            </span>
          </div>
          {/* Speech bubble */}
          <div
            style={{
              position: "fixed",
              bottom: "52px",
              left: bubbleLeft,
              zIndex: 99998,
              pointerEvents: "none",
              animation: "drun-bubbleIn 0.4s cubic-bezier(0.4,0,0.2,1)",
            }}
          >
            <div style={BUBBLE_STYLE}>
              <div style={TEXT_STYLE}>
                <TypewriterText sentences={sentences} onAllRevealed={onAllRevealed} />
              </div>
            </div>
            <BubbleTail offsetLeft={catchTailOffset} />
          </div>
        </>
      )}

      {phase === "result" && outcome === "egg" && (
        <>
          {/* Ground strip with dino + egg at their final positions */}
          <div
            style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              height: "48px",
              zIndex: 99997,
              background: "linear-gradient(to top, rgba(27,27,29,0.85) 0%, rgba(27,27,29,0) 100%)",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                bottom: "10px",
                left: 0,
                right: 0,
                height: "1.5px",
                background: "rgba(197, 168, 100, 0.25)",
              }}
            />
            {/* Dino — right next to egg, matching running phase position */}
            <span
              style={{
                position: "absolute",
                bottom: "12px",
                left: `${EGG_POS - 0.5}%`,
                fontSize: "26px",
                transform: "scaleX(-1)",
              }}
            >
              🦖
            </span>
            {/* Egg */}
            <span
              style={{
                position: "absolute",
                bottom: "12px",
                left: `${EGG_POS}%`,
                fontSize: "14px",
                animation: "drun-bounce 0.6s ease-in-out infinite",
              }}
            >
              🥚
            </span>
          </div>
          {/* Speech bubble — tail points at dino */}
          <div
            style={{
              position: "fixed",
              bottom: "40px",
              left: `clamp(10px, calc(${EGG_POS - 0.5}% - 34px), calc(100vw - 380px))`,
              zIndex: 99998,
              pointerEvents: "none",
              animation: "drun-bubbleIn 0.4s cubic-bezier(0.4,0,0.2,1)",
            }}
          >
            <div style={BUBBLE_STYLE}>
              <div style={TEXT_STYLE}>
                <TypewriterText sentences={sentences} onAllRevealed={onAllRevealed} />
              </div>
            </div>
            <BubbleTail offsetLeft={eggTailOffset} />
          </div>
        </>
      )}

      {/* ── Result: robot — ground strip + bubble from left edge ── */}
      {phase === "result" && outcome === "robot" && (
        <>
          {/* Ground strip */}
          <div
            style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              height: "48px",
              zIndex: 99997,
              background: "linear-gradient(to top, rgba(27,27,29,0.85) 0%, rgba(27,27,29,0) 100%)",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                bottom: "10px",
                left: 0,
                right: 0,
                height: "1.5px",
                background: "rgba(197, 168, 100, 0.25)",
              }}
            />
          </div>
          {/* Speech bubble */}
          <div
            style={{
              position: "fixed",
              bottom: "52px",
              left: "20px",
              zIndex: 99998,
              pointerEvents: "none",
              animation: "drun-fromPit 0.5s cubic-bezier(0.4,0,0.2,1)",
            }}
          >
            <div style={BUBBLE_STYLE}>
              <div
                style={{
                  fontSize: "10px",
                  color: "rgba(197, 168, 100, 0.5)",
                  marginBottom: "6px",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                * screaming from off-screen left *
              </div>
              <div style={TEXT_STYLE}>
                <TypewriterText sentences={sentences} onAllRevealed={onAllRevealed} />
              </div>
            </div>
            <BubbleTail />
            <div style={{ marginLeft: "8px", fontSize: "22px", lineHeight: 1 }}>🦖💨 ← 🤖</div>
          </div>
        </>
      )}
    </>
  );
}

/* ── Position helpers ──
 *  Both characters enter from off-screen left.
 *  Chicken: -6% → 84%   Dino: -10% → 82%
 *  Key landmarks: pit at 61%, egg drop at ~48%
 */

const EGG_DROP_P = 0.78; // progress when egg drops (past doc text)
const EGG_POS = -6 + EGG_DROP_P * 90; // ≈64.2% — clear of documentation text

/* Robot outcome constants */
const ROBOT_APPEAR_P = 0.76; // robot enters from right (dino close to chicken)
const ROBOT_SPEED = 130; // % per progress unit — slow, bouncy approach (~1.4s to chicken)
// Collision point: solve chickenLeft(p) = robotLeft(p)
// -6 + 90p = 102 - ROBOT_SPEED*(p - ROBOT_APPEAR_P)
const ROBOT_ZAP_P = (108 + ROBOT_SPEED * ROBOT_APPEAR_P) / (90 + ROBOT_SPEED); // ≈0.94
const ROBOT_ZAP_POS = -6 + ROBOT_ZAP_P * 90; // ≈78.4%
const DINO_ACCEL_P = 0.68; // dino starts accelerating toward chicken
const DINO_TURN_P = ROBOT_ZAP_P + 0.01; // ≈0.95 — turns after seeing chicken zapped
// Where the dino turns around (slowPos = freezePos - 12)
const DINO_TURN_POS = (() => {
  const fBase = -10 + ROBOT_APPEAR_P * 92;
  const fChicken = -6 + ROBOT_APPEAR_P * 90;
  return fBase + (fChicken - fBase) * 0.85 - 12;
})(); // ≈50%

/* Catch outcome constants */
const CATCH_BANG_P = 0.92; // bang when dino catches chicken
// Where dino stops after catching (computed from dinoLeft formula at CATCH_BANG_P)
const CATCH_DINO_STOP = (() => {
  const base = -10 + CATCH_BANG_P * 92;
  const chicken = -6 + CATCH_BANG_P * 90;
  return base + (chicken - base) * ((CATCH_BANG_P - 0.85) / 0.15) * 0.85;
})(); // ≈75.5%

/* Pit outcome constants — chicken jump is centered so peak is directly above pit */
const CHICKEN_JUMP_START = 0.674; // chicken starts jumping before pit
const CHICKEN_JUMP_END = 0.814; // chicken lands safely after pit
const CHICKEN_JUMP_PEAK = 0.744; // peak of arc — directly above pit at 61%
const PIT_APPEAR_P = CHICKEN_JUMP_PEAK; // pit appears at peak of chicken's jump
const DINO_FALL_P = 0.772; // dino reaches pit and starts falling

function dinoLeft(outcome: Outcome, p: number): number {
  const base = -10 + p * 92;
  if (outcome === "catch") {
    if (p > CATCH_BANG_P) return CATCH_DINO_STOP; // freeze at catch point
    if (p > 0.85) {
      const chickenPos = chickenLeft(outcome, p);
      return base + (chickenPos - base) * ((p - 0.85) / 0.15) * 0.85;
    }
  }
  if (outcome === "pit") {
    return Math.min(base, 61);
  }
  if (outcome === "egg" && p > EGG_DROP_P) {
    const dinoAtDrop = -10 + EGG_DROP_P * 92;
    const t = Math.min(1, (p - EGG_DROP_P) * 5);
    return dinoAtDrop + (EGG_POS - 0.5 - dinoAtDrop) * t;
  }
  if (outcome === "robot") {
    if (p < DINO_ACCEL_P) return base; // normal chase
    if (p < ROBOT_APPEAR_P) {
      // Accelerate toward chicken (like catch scenario — almost catches it)
      const chickenPos = chickenLeft(outcome, p);
      const accelT = (p - DINO_ACCEL_P) / (ROBOT_APPEAR_P - DINO_ACCEL_P);
      return base + (chickenPos - base) * accelT * 0.85;
    }
    // Freeze position: where dino was when robot appeared
    const fBase = -10 + ROBOT_APPEAR_P * 92;
    const fChicken = -6 + ROBOT_APPEAR_P * 90;
    const freezePos = fBase + (fChicken - fBase) * 0.85;
    if (p < ROBOT_APPEAR_P + 0.01) return freezePos; // brief freeze
    if (p < ROBOT_ZAP_P) {
      // Slow retreat — backing away while still facing right ("спиной назад")
      const t = (p - ROBOT_APPEAR_P - 0.01) / (ROBOT_ZAP_P - ROBOT_APPEAR_P - 0.01);
      return freezePos - 12 * t;
    }
    const slowPos = freezePos - 12; // position after slow retreat
    if (p < DINO_TURN_P) return slowPos; // shock pause — sees chicken get zapped
    // Turn and run — linear speed for steady, readable exit
    const t = (p - DINO_TURN_P) / (1 - DINO_TURN_P);
    return slowPos - (slowPos + 15) * t;
  }
  return base;
}

/** Dino faces right (scaleX -1) normally; faces left in robot retreat */
function dinoScaleX(outcome: Outcome, p: number): number {
  if (outcome === "robot" && p > DINO_TURN_P) return 1; // face left (running away)
  return -1; // face right (chasing)
}

function dinoBottom(outcome: Outcome, p: number): string {
  if (outcome === "pit" && p > DINO_FALL_P) {
    const fall = (p - DINO_FALL_P) * 300;
    return `${12 - fall}px`;
  }
  return "12px";
}

function dinoOpacity(outcome: Outcome, p: number): number {
  if (outcome === "pit" && p > DINO_FALL_P + 0.03) {
    return Math.max(0, 1 - (p - DINO_FALL_P - 0.03) * 12);
  }
  return 1;
}

function chickenLeft(outcome: Outcome, p: number): number {
  const base = -6 + p * 90;
  if (outcome === "egg" && p > EGG_DROP_P) {
    if (p < EGG_DROP_P + 0.08) return EGG_POS;
    return EGG_POS + (p - EGG_DROP_P - 0.08) * 160;
  }
  if (outcome === "robot") {
    // Chicken runs normally until zapped at ROBOT_ZAP_P
    if (p >= ROBOT_ZAP_P) return ROBOT_ZAP_POS; // stays at zap spot (hidden)
    return base;
  }
  return base;
}

function chickenBottom(outcome: Outcome, p: number): string {
  if (outcome === "pit" && p > CHICKEN_JUMP_START && p < CHICKEN_JUMP_END) {
    const jumpP = (p - CHICKEN_JUMP_START) / (CHICKEN_JUMP_END - CHICKEN_JUMP_START);
    const y = Math.sin(jumpP * Math.PI) * 32;
    return `${12 + y}px`;
  }
  return "12px";
}

/** Robot enters from right when dino is about to catch chicken.
 *  Uses crossfade interpolation around the zap point for velocity-continuous
 *  transition from approach to tracking the dino. */
function robotLeft(p: number): number {
  if (p < ROBOT_APPEAR_P) return 102; // off-screen right

  // Crossfade blend starts AT the zap point (not before — so robot visually touches chicken)
  const blendStart = ROBOT_ZAP_P;
  if (p < blendStart) {
    // Pure linear approach
    return 102 - ROBOT_SPEED * (p - ROBOT_APPEAR_P);
  }

  // Where robot WOULD be if still approaching linearly
  const approachPos = 102 - ROBOT_SPEED * (p - ROBOT_APPEAR_P);
  // Where robot should be when tracking dino at fixed offset
  const trackPos = dinoLeft("robot", p) + 12;

  // Smoothstep crossfade: velocity-continuous at both boundaries
  const blendRange = 0.04;
  const t = Math.min(1, (p - blendStart) / blendRange);
  const s = t * t * (3 - 2 * t); // smoothstep

  return approachPos * (1 - s) + trackPos * s;
}
