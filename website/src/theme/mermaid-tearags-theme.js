// TeaRAGs Mermaid Theme - Dark variant
export const teaRagsDark = {
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

// TeaRAGs Mermaid Theme - Light variant
export const teaRagsLight = {
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

// Utility function to format theme for Mermaid init block
export const formatMermaidTheme = (themeConfig) => {
  return `%%{init: ${JSON.stringify(themeConfig)}}%%`;
};
