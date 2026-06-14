/**
 * Static marketing/SEO copy shown above the drop zone on the home view. Lives
 * in React (rendered client-side); the crawlable `<head>` meta + JSON-LD stay
 * static in index.html.
 */
export function SeoIntro() {
  return (
    <section id="seo-intro" className="seo-intro">
      <h2>Análise de Replays do Ragnarok Online</h2>
      <p>
        O <strong>RagnaRecap</strong> lê arquivos <code>.rrf</code> gerados pelo cliente do
        Ragnarok Online e mostra estatísticas detalhadas da sessão: dano por jogador, abates,
        tempo até o kill, equipamentos, gráfico de HP, análise de DPS por janela e muito mais.
        A decodificação acontece direto no navegador, sem instalação.
      </p>
      <h3>Como funciona</h3>
      <p>
        Arraste um <code>.rrf</code> na área abaixo ou clique para selecionar. Cada replay
        ganha automaticamente um link curto (<code>?r=&lt;id&gt;</code>) que reabre a mesma
        análise em qualquer navegador — perfeito para compartilhar com seu time.
      </p>
    </section>
  );
}
