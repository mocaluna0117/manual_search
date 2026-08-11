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

export const INVITE_USER_MUTATION: TypedDocumentNode<
  { inviteUser: ManagedUser },
  { email: string; role: UserRole }
> = gql`
  mutation InviteUser($email: String!, $role: UserRole) {
    inviteUser(email: $email, role: $role) {
      cognitoSub
      email
      role
      passwordPending
      createdAt
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
