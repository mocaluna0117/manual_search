import { Box } from '@chakra-ui/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * AIの回答(Markdown)を整形して表示する。
 * 見出し・箇条書き・太字・表などが「記号のまま」ではなく読みやすい形になる。
 * remark-gfm = 表やチェックリストなどGitHub流の記法への対応
 */
export function MarkdownText({ children }: { children: string }) {
  return (
    <Box
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
        '& table': {
          borderCollapse: 'collapse',
          marginBottom: '0.6em',
          fontSize: '0.95em',
        },
        '& th, & td': {
          border: '1px solid',
          borderColor: 'gray.300',
          padding: '4px 10px',
        },
        '& th': { background: 'rgba(0,0,0,0.04)' },
        '& code': {
          background: 'rgba(0,0,0,0.06)',
          padding: '0 4px',
          borderRadius: '4px',
          fontSize: '0.9em',
        },
        '& blockquote': {
          borderLeft: '3px solid',
          borderColor: 'gray.300',
          paddingLeft: '0.8em',
          color: 'gray.600',
          marginBottom: '0.6em',
        },
        '& hr': { margin: '0.8em 0', borderColor: 'gray.200' },
        '& a': { color: 'blue.600', textDecoration: 'underline' },
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </Box>
  )
}
