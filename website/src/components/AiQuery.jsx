import React from 'react';

/**
 * AiQuery — styled blockquote for AI/agent queries with monospace font.
 *
 * Usage in MDX:
 *
 * import AiQuery from '@site/src/components/AiQuery';
 *
 * <AiQuery>
 * How does authentication work in this project?
 * </AiQuery>
 *
 * Multiple queries:
 *
 * <AiQuery>
 * Find where we handle payment errors
 * </AiQuery>
 */
const AiQuery = ({ children }) => {
  return (
    <blockquote className="ai-query">
      {typeof children === 'string'
        ? children.split('\n').filter(Boolean).map((line, i) => (
            <p key={i}>{line.trim()}</p>
          ))
        : children}
    </blockquote>
  );
};

export default AiQuery;
