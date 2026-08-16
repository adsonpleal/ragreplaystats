export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="muted small">
        Veja também outras ferramentas em{" "}
        <a href="https://latam-tools.com.br" target="_blank" rel="noopener">
          latam-tools.com.br
        </a>
        .
      </p>
      <p className="muted small">
        Sugestões e bugs no{" "}
        <a
          href="https://issues.latam-tools.com.br/novo?projeto=recap"
          target="_blank"
          rel="noopener noreferrer"
        >
          rastreador de issues
        </a>
        . Projeto open source no{" "}
        <a href="https://github.com/adsonpleal/ragreplaystats" target="_blank" rel="noopener">
          GitHub
        </a>
        .
      </p>
    </footer>
  );
}
