import React from 'react';
import Mermaid from '@theme/Mermaid';
import { useColorMode } from '@docusaurus/theme-common';

/**
 * MermaidTeaRAGs - Mermaid diagram wrapper with automatic TeaRAGs theme switching
 *
 * Usage in MDX:
 *
 * import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';
 *
 * <MermaidTeaRAGs>
 * {`
 * flowchart LR
 *   A[Node A] --> B[Node B]
 * `}
 * </MermaidTeaRAGs>
 */
const MermaidTeaRAGs = ({ children }) => {
  const { colorMode } = useColorMode();

  // TeaRAGs Dark Theme
  const darkTheme = {
    theme: 'base',
    themeVariables: {
      primaryColor: '#1a1a1a',
      primaryTextColor: '#d4af37',
      primaryBorderColor: '#d4af37',
      lineColor: '#d4af37',
      secondaryColor: '#2d2d2d',
      tertiaryColor: '#3d3d3d',
      background: 'transparent',
      mainBkg: '#1a1a1aFA',
      secondBkg: '#2d2d2dF5',
      tertiaryBkg: '#d4af37',
      nodeBorder: '#d4af37',
      clusterBkg: '#00000008',
      clusterBorder: '#d4af3780',
      titleColor: '#d4af37',
      edgeLabelBackground: '#00000000',
      fontSize: '15px',
    },
  };

  // TeaRAGs Light Theme
  const lightTheme = {
    theme: 'base',
    themeVariables: {
      primaryColor: '#ffffff',
      primaryTextColor: '#2d2d2d',
      primaryBorderColor: '#d4af37',
      lineColor: '#c4941f',
      secondaryColor: '#f5f5f5',
      tertiaryColor: '#fafafa',
      background: 'transparent',
      mainBkg: '#ffffffF8',
      secondBkg: '#f5f5dcF8',
      tertiaryBkg: '#d4af37',
      nodeBorder: '#d4af37',
      clusterBkg: '#f5f5dc10',
      clusterBorder: '#d4af37A0',
      titleColor: '#2d2d2d',
      edgeLabelBackground: '#ffffff80',
      fontSize: '15px',
    },
  };

  const currentTheme = colorMode === 'dark' ? darkTheme : lightTheme;
  const themeInit = `%%{init: ${JSON.stringify(currentTheme)}}%%\n`;

  return (
    <Mermaid value={themeInit + children.trim()} />
  );
};

export default MermaidTeaRAGs;
