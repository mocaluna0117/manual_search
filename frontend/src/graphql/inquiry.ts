import { gql, type TypedDocumentNode } from '@apollo/client'

interface SendInquiryData {
  sendInquiry: boolean
}

interface SendInquiryVars {
  message: string
  /** 画面のスクリーンショット(任意)。メールに添付されて届く */
  imageBase64?: string
  imageFormat?: string
}

export const SEND_INQUIRY_MUTATION: TypedDocumentNode<
  SendInquiryData,
  SendInquiryVars
> = gql`
  mutation SendInquiry(
    $message: String!
    $imageBase64: String
    $imageFormat: String
  ) {
    sendInquiry(
      message: $message
      imageBase64: $imageBase64
      imageFormat: $imageFormat
    )
  }
`
