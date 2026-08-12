import { gql, type TypedDocumentNode } from '@apollo/client'

interface SendInquiryData {
  sendInquiry: boolean
}

interface SendInquiryVars {
  message: string
}

export const SEND_INQUIRY_MUTATION: TypedDocumentNode<
  SendInquiryData,
  SendInquiryVars
> = gql`
  mutation SendInquiry($message: String!) {
    sendInquiry(message: $message)
  }
`
