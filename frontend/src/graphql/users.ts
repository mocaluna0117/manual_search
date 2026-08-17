import { gql, type TypedDocumentNode } from '@apollo/client'
import type { UserRole } from './me'

// 管理画面(ユーザー管理)用。アカウントの実体はCognito、権限はDB
export interface ManagedUser {
  cognitoSub: string
  email: string | null
  role: UserRole
  passwordPending: boolean // 招待直後(まだ一度もログインしていない)
  createdAt: string | null
}

export const USERS_QUERY: TypedDocumentNode<{ users: ManagedUser[] }> = gql`
  query Users {
    users {
      cognitoSub
      email
      role
      passwordPending
      createdAt
    }
  }
`

/** まとめて招待した結果。送れた分と送れなかった分の両方が返る */
export interface InviteResult {
  invited: ManagedUser[]
  failed: { email: string; reason: string }[]
}

export const INVITE_USERS_MUTATION: TypedDocumentNode<
  { inviteUsers: InviteResult },
  { emails: string[]; role: UserRole }
> = gql`
  mutation InviteUsers($emails: [String!]!, $role: UserRole) {
    inviteUsers(emails: $emails, role: $role) {
      invited {
        cognitoSub
        email
        role
        passwordPending
        createdAt
      }
      failed {
        email
        reason
      }
    }
  }
`

export const UPDATE_USER_ROLE_MUTATION: TypedDocumentNode<
  { updateUserRole: ManagedUser },
  { cognitoSub: string; role: UserRole }
> = gql`
  mutation UpdateUserRole($cognitoSub: ID!, $role: UserRole!) {
    updateUserRole(cognitoSub: $cognitoSub, role: $role) {
      cognitoSub
      role
    }
  }
`

export const DELETE_USER_MUTATION: TypedDocumentNode<
  { deleteUser: boolean },
  { cognitoSub: string }
> = gql`
  mutation DeleteUser($cognitoSub: ID!) {
    deleteUser(cognitoSub: $cognitoSub)
  }
`
