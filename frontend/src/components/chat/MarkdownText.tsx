import { Box } from '@chakra-ui/react'
import { Children, isValidElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import { IconLine, splitLeadingIcon, withInlineIcons } from './MessageIcons'

/**
 * 段落の先頭にある管理操作の絵文字(📁⏳🗑など)をアイコンに差し替える。
 * 先頭以外に紛れている絵文字(📌など)もインラインで置き換える
 */
function renderWithIcons(children: ReactNode): ReactNode {
  const nodes = Children.toArray(children)
  const first = nodes[0]

  if (typeof first === 'string') {
    const split = splitLeadingIcon(first)
    if (split) {
      const rest = [withInlineIcons(split.rest), ...nodes.slice(1)]
      return <IconLine icon={split.icon}>{rest}</IconLine>
    }
  }
  // 先頭が絵文字でなければ、文字列部分だけインライン置換する
  return nodes.map((node, i) =>
    typeof node === 'string' ? (
      <span key={i}>{withInlineIcons(node)}</span>
    ) : isValidElement(node) ? (
      node
    ) : (
      node
    ),
  )
}

/**
 * AIの回答(Markdown)を整形して表示する。
 * 見出し・箇条書き・太字・表などが「記号のまま」ではなく読みやすい形になる。
 * - remark-gfm = 表やチェックリストなどGitHub流の記法への対応
 * - remark-cjk-friendly = 日本語で太字が効かない問題への対応。
 *   CommonMarkの規則では「**」の隣が全角記号だと強調と見なされず、
 *   例えば **「太字」** や **手順:** がアスタリスクのまま表示されてしまう
 */
export function MarkdownText({ children }: { children: string }) {
  return (
    <Box
      // 区切りの無い長い文章(日本語のマニュアル本文やURL・型番など)でも
      // 吹き出しの外へはみ出さないよう、全体に折り返しを効かせる
      overflowWrap="anywhere"
      css={{
        '& p': { marginBottom: '0.6em' },
        '& > *:last-child': { marginBottom: 0 },
        '& ul, & ol': { paddingLeft: '1.5em', marginBottom: '0.6em' },
        '& li': { marginBottom: '0.2em' },
        '& h1, & h2, & h3, & h4': {
          fontWeight: 'bold',
          marginTop: '0.9em',
          marginBottom: '0.4em',
        },
        '& h1': { fontSize: '1.15em' },
        '& h2': { fontSize: '1.1em' },
        '& h3, & h4': { fontSize: '1em' },
        '& > h1:first-child, & > h2:first-child, & > h3:first-child': {
          marginTop: 0,
        },
        '& strong': { fontWeight: 700 },
        // 表は縮まないので、はみ出す場合は表の中だけ横スクロールさせる
        '& table': {
          borderCollapse: 'collapse',
          marginBottom: '0.6em',
          fontSize: '0.95em',
          display: 'block',
          width: 'max-content',
          maxWidth: '100%',
          overflowX: 'auto',
        },
        '& th, & td': {
          border: '1px solid',
          borderColor: 'border.emphasized',
          padding: '4px 10px',
        },
        '& th': { background: 'bg.emphasized' },
        '& code': {
          background: 'bg.emphasized',
          padding: '0 4px',
          borderRadius: '4px',
          fontSize: '0.9em',
          overflowWrap: 'anywhere',
        },
        // コードブロック(```)は既定のwhite-space:preで折り返されず、
        // メール文例のような長文がそのまま横へ突き抜けるので折り返す
        '& pre': {
          background: 'bg.emphasized',
          padding: '8px 10px',
          borderRadius: '6px',
          marginBottom: '0.6em',
          maxWidth: '100%',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
        // 中のcodeは背景が二重になるので消す(折り返しはpre側に任せる)
        '& pre code': {
          background: 'transparent',
          padding: 0,
          borderRadius: 0,
        },
        '& blockquote': {
          borderLeft: '3px solid',
          borderColor: 'border.emphasized',
          paddingLeft: '0.8em',
          color: 'fg.muted',
          marginBottom: '0.6em',
        },
        '& hr': { margin: '0.8em 0', borderColor: 'border' },
        '& a': { color: 'blue.fg', textDecoration: 'underline' },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly]}
        components={{
          p: ({ children }) => <p>{renderWithIcons(children)}</p>,
          li: ({ children }) => <li>{renderWithIcons(children)}</li>,
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  )
}
