import { useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from '@chakra-ui/react'
import type { IconType } from 'react-icons'
import {
  LuBot,
  LuFileImage,
  LuFolderTree,
  LuLifeBuoy,
  LuMessageCircleQuestion,
  LuNotebookPen,
  LuSearch,
  LuSettings,
  LuUpload,
  LuUsers,
} from 'react-icons/lu'
import { ME_QUERY } from '../../graphql/me'

interface HelpDialogProps {
  open: boolean
  onClose: () => void
  /** 画像つきのガイドPDFを開く(ビューアはダイアログの外なので閉じてから呼ぶ) */
  onOpenPdf: () => void
}

interface HelpItem {
  label: string
  body: string
}

interface HelpSection {
  title: string
  icon: IconType
  adminOnly?: boolean
  items: HelpItem[]
}

// 使い方の本文。実装を変えたら必ずここも更新する
// (PDF版はdocs/usage-guide/index.html。両方を揃えること)
const SECTIONS: HelpSection[] = [
  {
    title: 'AIに質問する（チャット）',
    icon: LuMessageCircleQuestion,
    items: [
      {
        label: '質問のしかた',
        body: '入力欄に知りたいことを書いて「検索」を押すだけです。例:「クイックパーツマニュアルを見せて」「床鳴りの対応手順は？」。話し言葉のままで大丈夫です。',
      },
      {
        label: '回答の根拠からPDFを開く',
        body: '回答の下に根拠マニュアルのカードが出ます。マニュアル名や「p.3」のようなページボタンを押すと、該当ページが直接開きます。',
      },
      {
        label: '絞り込みの選択肢',
        body: 'AIが選択肢ボタンを出したら、当てはまるものをクリックするだけで答えられます。当てはまらなければ「その他」欄に自由に入力してください。',
      },
      {
        label: 'よく使う質問（テンプレート）',
        body: '入力欄左の吹き出しアイコンから定型文を選べます。「〇〇」の部分が選択状態で入るので、そのまま打ち替えれば完成です。',
      },
      {
        label: '画像で質問する',
        body: '画像アイコンからスクリーンショット等を添付できます（PNG/JPEG/WebP/GIF、4MBまで）。文章なしで画像だけでも検索できます。',
      },
      {
        label: '停止・編集して再送信',
        body: '生成中は「停止」ボタンで中断できます。送信済みの質問は鉛筆アイコンで入力欄に戻し、書き直して再送信できます。',
      },
      {
        label: 'コピー',
        body: '吹き出し右下のコピーアイコンで本文全体をコピーできます。メール文例などの枠には右上に専用の「コピー」ボタンがあり、その部分だけを取り出せます。',
      },
    ],
  },
  {
    title: 'マニュアルを探す・読む',
    icon: LuSearch,
    items: [
      {
        label: 'キーワード検索',
        body: 'サイドバーの「マニュアル名・内容で検索」にキーワードを入れてEnter。タイトルと本文の両方を検索し、一致箇所がハイライトされます。',
      },
      {
        label: 'フォルダから探す',
        body: 'サイドバーの「マニュアル」でエクスプローラーが開きます。フォルダやマニュアルはダブルクリックで開きます（1回クリックは選択）。',
      },
      {
        label: '表示の切り替え・並べ替え',
        body: '一覧右上のボタンで「詳細」と「中アイコン」を切り替えられます。詳細表示では「名前」「作成日」「サイズ」のヘッダーで並べ替えできます（作成日はPDF自身が持つ作成日です）。',
      },
      {
        label: 'マニュアルの状態',
        body: '名前の横のオレンジの時計は「取り込み中」（AI検索にまだ出ません）、赤い三角は「取り込み失敗」です。何も付いていなければ検索できる状態です。',
      },
    ],
  },
  {
    title: '画面の調整',
    icon: LuSettings,
    items: [
      {
        label: '設定',
        body: 'サイドバー下部の「設定」から、送信キー（Enterで送信 / Shift+Enterで送信）、配色（端末に合わせる・ライト・ダーク）、画面の並び（左に1枚 / チャット左 / マニュアル左）を変えられます。',
      },
      {
        label: 'サイドバー',
        body: '端をドラッグすると幅を調整でき、上部のパネルアイコンで折りたためます。設定はブラウザに記憶されます。',
      },
    ],
  },
  {
    title: '困ったとき',
    icon: LuLifeBuoy,
    items: [
      {
        label: '見つからないとき',
        body: '言い方を変えて聞き直すか、キーワード検索も試してください。それでも見つからないマニュアルは「問い合わせ」から教えてもらえると追加を検討できます。',
      },
      {
        label: '問い合わせ',
        body: 'サイドバー下部の「問い合わせ」から、不具合の報告・使い方の質問・追加してほしいマニュアルなどを管理者へ送れます。',
      },
    ],
  },
  {
    title: 'マニュアルの追加・管理',
    icon: LuUpload,
    adminOnly: true,
    items: [
      {
        label: 'アップロード',
        body: '「マニュアルを追加」からPDFをドラッグ&ドロップ（複数可）。カテゴリは「AIにおまかせ」がおすすめで、内容を読んで自動で振り分けます（合うフォルダが無ければ作成）。',
      },
      {
        label: '同名ファイルの差し替え',
        body: '同名のファイルをアップロードすると、更新日が新しい方だけが残ります。古い方を上げてしまってもスキップされるので安心です。',
      },
      {
        label: '再取り込み・削除',
        body: '取り込みに失敗したマニュアルは右クリック →「再取り込み」でやり直せます。削除も右クリックから（元に戻せません）。',
      },
    ],
  },
  {
    title: 'フォルダと分類',
    icon: LuFolderTree,
    adminOnly: true,
    items: [
      {
        label: 'フォルダの管理',
        body: 'サイドバーの「＋」で作成、鉛筆で名前変更、ゴミ箱で削除（中身が空のときだけ）。フォルダ自体をドラッグすると並び替えられます。',
      },
      {
        label: 'マニュアルの移動',
        body: 'マニュアルをドラッグして一覧またはサイドバーのフォルダへドロップします。「未分類」に落とすと分類を外せます。',
      },
      {
        label: 'ピン留め',
        body: '右クリック →「ピン留め」で、AIの再分類から保護できます（手動の判断を守る仕組み）。ピンの付け外しは手動のみです。',
      },
      {
        label: 'AIで再分類',
        body: 'サイドバーのロボットアイコンで全マニュアルをAIが分類し直します（数分かかります。ピン留めは動きません）。未分類だけを対象にするボタンは一覧のツールバーにあります。',
      },
      {
        label: '分類ルール',
        body: 'サイドバーの定規アイコンから、AIに教える分類の決まりごとを登録できます（例:「床暖房関連はフローリング関連に入れる」）。アップロード時の自動分類と再分類の両方に適用されます。',
      },
    ],
  },
  {
    title: 'チャットでの管理操作',
    icon: LuBot,
    adminOnly: true,
    items: [
      {
        label: 'フォルダ作成',
        body: '「〇〇というフォルダを作って」と頼むと、すぐに作成されます。',
      },
      {
        label: '1件だけ移動',
        body: '「〇〇のマニュアルを△△に移して」で、そのマニュアルを今すぐ移動します。名前が曖昧なときは候補が出るので選び直してください。',
      },
      {
        label: '今後の方針を教える',
        body: '「今後〜は〜に分類して」は分類ルールとして保存され、次回の分類から効きます（その場では動きません）。',
      },
      {
        label: '全件の再分類',
        body: '「全マニュアルを再分類して」と頼むと確認ボタンが出ます。実行すると数分かかり、完了すると同じ会話に結果が届きます。',
      },
    ],
  },
  {
    title: 'ユーザー管理',
    icon: LuUsers,
    adminOnly: true,
    items: [
      {
        label: '招待・権限・削除',
        body: 'サイドバーの「ユーザー管理」から、メールアドレスで招待（仮パスワード付きの招待メールが届きます）、一般/管理者の切り替え、削除ができます。',
      },
    ],
  },
  {
    title: 'テンプレートの管理',
    icon: LuNotebookPen,
    adminOnly: true,
    items: [
      {
        label: 'よく使う質問を育てる',
        body: 'チャットのテンプレート一覧の下の「テンプレートを管理」から追加・編集・削除・並び替えができます。本文に「〇〇」を入れておくと、挿入時にその部分が選択状態になります。',
      },
    ],
  },
]

/** 使い方ガイド。管理者には管理機能の説明も表示する */
export function HelpDialog({ open, onClose, onOpenPdf }: HelpDialogProps) {
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const sections = SECTIONS.filter((s) => isAdmin || !s.adminOnly)

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && onClose()}
      size="lg"
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>使い方ガイド</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack gap={6} align="stretch">
                {sections.map((section) => (
                  <Box key={section.title}>
                    <HStack gap={2} mb={2}>
                      <Box color="blue.fg">
                        <section.icon />
                      </Box>
                      <Text fontWeight="bold">{section.title}</Text>
                      {section.adminOnly && (
                        <Badge colorPalette="purple" size="sm">
                          管理者のみ
                        </Badge>
                      )}
                    </HStack>
                    <VStack gap={2} align="stretch" pl={6}>
                      {section.items.map((item) => (
                        <Box key={item.label}>
                          <Text fontSize="sm" fontWeight="medium">
                            {item.label}
                          </Text>
                          <Text fontSize="sm" color="fg.muted">
                            {item.body}
                          </Text>
                        </Box>
                      ))}
                    </VStack>
                  </Box>
                ))}
                <Text fontSize="xs" color="fg.subtle">
                  実際の画面の画像で見たいときは、下の「画像つきガイド(PDF)を開く」からどうぞ。
                  チャットで「使い方を教えて」と聞いても、このガイドの内容をAIが案内します。
                </Text>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer justifyContent="space-between">
              <Button
                colorPalette="blue"
                variant="subtle"
                onClick={() => {
                  onClose()
                  onOpenPdf()
                }}
              >
                <LuFileImage /> 画像つきガイド(PDF)を開く
              </Button>
              <Button variant="outline" onClick={onClose}>
                閉じる
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
