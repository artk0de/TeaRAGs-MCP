import React from "react";
import DinoTooltip from "./DinoTooltip";

export default function DinoLogo() {
  const handleClick = () => {
    window.dispatchEvent(new CustomEvent("dinorun-trigger"));
  };

  return (
    <div style={{ textAlign: "center", marginBottom: "2rem" }}>
      <DinoTooltip>
        <img
          src="/tea-rags/img/logo.png"
          alt="TeaRAGs"
          onClick={handleClick}
          style={{ width: "280px", cursor: "pointer" }}
        />
      </DinoTooltip>
    </div>
  );
}
