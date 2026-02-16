import React, { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import dinoQuestions from "./dinoQuestions";

interface DinoTooltipProps {
  children: React.ReactNode;
}

export default function DinoTooltip({ children }: DinoTooltipProps) {
  const [tooltip, setTooltip] = useState("");
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    const idx = Math.floor(Math.random() * dinoQuestions.length);
    setTooltip(dinoQuestions[idx]);
    timeoutRef.current = setTimeout(() => setVisible(true), 400);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    setPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(false);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Keep tooltip within viewport
  const left = Math.min(pos.x + 16, (typeof window !== "undefined" ? window.innerWidth : 9999) - 360);
  const top = pos.y + 16;

  const tooltipEl =
    visible && typeof document !== "undefined"
      ? createPortal(
          <div
            style={{
              position: "fixed",
              left,
              top,
              background: "rgba(27, 27, 29, 0.92)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              color: "#e8e0d0",
              padding: "12px 18px",
              borderRadius: "0.75rem",
              border: "1px solid rgba(197, 168, 100, 0.2)",
              fontSize: "13px",
              fontWeight: 500,
              fontFamily:
                '"Inter", system-ui, -apple-system, sans-serif',
              maxWidth: "340px",
              width: "max-content",
              pointerEvents: "none",
              zIndex: 99999,
              boxShadow:
                "0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(197,168,100,0.08)",
              lineHeight: 1.5,
              letterSpacing: "-0.01em",
            }}
          >
            {tooltip}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      {children}
      {tooltipEl}
    </div>
  );
}
