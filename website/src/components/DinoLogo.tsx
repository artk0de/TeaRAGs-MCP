import React from "react";
import useBaseUrl from "@docusaurus/useBaseUrl";
import DinoTooltip from "./DinoTooltip";

export default function DinoLogo() {
  const logoSrc = useBaseUrl("/img/logo.png");
  const handleClick = () => {
    window.dispatchEvent(new CustomEvent("dinorun-trigger"));
  };

  return (
    <div style={{ textAlign: "center", marginBottom: "2rem" }}>
      <DinoTooltip>
        <img
          src={logoSrc}
          alt="TeaRAGs"
          onClick={handleClick}
          style={{ width: "280px", cursor: "pointer" }}
        />
      </DinoTooltip>
    </div>
  );
}
