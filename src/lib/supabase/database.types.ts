
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "access_links": {
                  Row: {
                    "consumed_at": string | null,"contract_id": string | null,"created_at": string,"expires_at": string,"id": string,"intended_client_id": string,"proposal_id": string,"purpose": string,"revoked_at": string | null,"tenant_id": string,"token_hash": string,"updated_at": string
                  }
                  Insert: {
                    "consumed_at"?: string | null,"contract_id"?: string | null,"created_at"?: string,"expires_at": string,"id": string,"intended_client_id": string,"proposal_id": string,"purpose": string,"revoked_at"?: string | null,"tenant_id": string,"token_hash": string,"updated_at"?: string
                  }
                  Update: {
                    "consumed_at"?: string | null,"contract_id"?: string | null,"created_at"?: string,"expires_at"?: string,"id"?: string,"intended_client_id"?: string,"proposal_id"?: string,"purpose"?: string,"revoked_at"?: string | null,"tenant_id"?: string,"token_hash"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "access_links_client_fk"
      columns: ["tenant_id","intended_client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "access_links_contract_fk"
      columns: ["tenant_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "access_links_proposal_fk"
      columns: ["tenant_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "access_links_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_events": {
                  Row: {
                    "action": string,"actor_id": string | null,"actor_type": string,"entity_id": string,"entity_type": string,"id": string,"metadata": NonNullable<Json>,"occurred_at": string,"tenant_id": string
                  }
                  Insert: {
                    "action": string,"actor_id"?: string | null,"actor_type": string,"entity_id": string,"entity_type": string,"id"?: string,"metadata"?: NonNullable<Json>,"occurred_at"?: string,"tenant_id": string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"actor_type"?: string,"entity_id"?: string,"entity_type"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"occurred_at"?: string,"tenant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_events_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"clients": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"email": string,"id": string,"name": string,"phone": string | null,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"email": string,"id"?: string,"name": string,"phone"?: string | null,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"email"?: string,"id"?: string,"name"?: string,"phone"?: string | null,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "clients_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"contract_documents": {
                  Row: {
                    "byte_size": number,"content_sha256": string,"contract_id": string,"created_at": string,"event_id": string,"generated_at": string,"id": string,"kind": string,"pdf_sha256": string,"renderer": string,"signature_sha256": string,"storage_bucket": string,"storage_path": string,"tenant_id": string
                  }
                  Insert: {
                    "byte_size": number,"content_sha256": string,"contract_id": string,"created_at"?: string,"event_id": string,"generated_at"?: string,"id"?: string,"kind"?: string,"pdf_sha256": string,"renderer": string,"signature_sha256": string,"storage_bucket"?: string,"storage_path": string,"tenant_id": string
                  }
                  Update: {
                    "byte_size"?: number,"content_sha256"?: string,"contract_id"?: string,"created_at"?: string,"event_id"?: string,"generated_at"?: string,"id"?: string,"kind"?: string,"pdf_sha256"?: string,"renderer"?: string,"signature_sha256"?: string,"storage_bucket"?: string,"storage_path"?: string,"tenant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_documents_contract_fk"
      columns: ["tenant_id","event_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["tenant_id","event_id","id"]
    },{
      foreignKeyName: "contract_documents_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"contract_signatures": {
                  Row: {
                    "client_ip": unknown,"client_ip_source": string,"consent_text": string,"consent_version": string,"content_sha256": string,"contract_id": string,"created_at": string,"event_id": string,"id": string,"signature_bucket": string,"signature_bytes": number,"signature_height": number,"signature_path": string,"signature_sha256": string,"signature_width": number,"signed_at": string,"signer_client_id": string,"signer_email": string,"signer_user_id": string,"tenant_id": string,"typed_name": string,"user_agent": string | null
                  }
                  Insert: {
                    "client_ip"?: unknown,"client_ip_source": string,"consent_text": string,"consent_version": string,"content_sha256": string,"contract_id": string,"created_at"?: string,"event_id": string,"id"?: string,"signature_bucket"?: string,"signature_bytes": number,"signature_height": number,"signature_path": string,"signature_sha256": string,"signature_width": number,"signed_at"?: string,"signer_client_id": string,"signer_email": string,"signer_user_id": string,"tenant_id": string,"typed_name": string,"user_agent"?: string | null
                  }
                  Update: {
                    "client_ip"?: unknown,"client_ip_source"?: string,"consent_text"?: string,"consent_version"?: string,"content_sha256"?: string,"contract_id"?: string,"created_at"?: string,"event_id"?: string,"id"?: string,"signature_bucket"?: string,"signature_bytes"?: number,"signature_height"?: number,"signature_path"?: string,"signature_sha256"?: string,"signature_width"?: number,"signed_at"?: string,"signer_client_id"?: string,"signer_email"?: string,"signer_user_id"?: string,"tenant_id"?: string,"typed_name"?: string,"user_agent"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_signatures_client_fk"
      columns: ["tenant_id","signer_client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "contract_signatures_contract_fk"
      columns: ["tenant_id","event_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["tenant_id","event_id","id"]
    },{
      foreignKeyName: "contract_signatures_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"contract_template_versions": {
                  Row: {
                    "client_use_confirmed_at": string | null,"client_use_confirmed_by_user_id": string | null,"client_use_statement": string | null,"client_use_statement_version": string | null,"content_sha256": string | null,"created_at": string,"created_by_membership_id": string | null,"draft_version": number,"id": string,"placeholders": (string)[],"published_at": string | null,"published_by_membership_id": string | null,"sections": NonNullable<Json>,"template_id": string,"tenant_id": string,"title": string,"updated_at": string,"usage": string | null,"version_number": number
                  }
                  Insert: {
                    "client_use_confirmed_at"?: string | null,"client_use_confirmed_by_user_id"?: string | null,"client_use_statement"?: string | null,"client_use_statement_version"?: string | null,"content_sha256"?: string | null,"created_at"?: string,"created_by_membership_id"?: string | null,"draft_version"?: number,"id"?: string,"placeholders"?: (string)[],"published_at"?: string | null,"published_by_membership_id"?: string | null,"sections": NonNullable<Json>,"template_id": string,"tenant_id": string,"title": string,"updated_at"?: string,"usage"?: string | null,"version_number": number
                  }
                  Update: {
                    "client_use_confirmed_at"?: string | null,"client_use_confirmed_by_user_id"?: string | null,"client_use_statement"?: string | null,"client_use_statement_version"?: string | null,"content_sha256"?: string | null,"created_at"?: string,"created_by_membership_id"?: string | null,"draft_version"?: number,"id"?: string,"placeholders"?: (string)[],"published_at"?: string | null,"published_by_membership_id"?: string | null,"sections"?: NonNullable<Json>,"template_id"?: string,"tenant_id"?: string,"title"?: string,"updated_at"?: string,"usage"?: string | null,"version_number"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_template_versions_created_by_fk"
      columns: ["tenant_id","created_by_membership_id"]
isOneToOne: false
      referencedRelation: "tenant_memberships"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "contract_template_versions_published_by_fk"
      columns: ["tenant_id","published_by_membership_id"]
isOneToOne: false
      referencedRelation: "tenant_memberships"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "contract_template_versions_template_fk"
      columns: ["tenant_id","template_id"]
isOneToOne: false
      referencedRelation: "contract_templates"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "contract_template_versions_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"contract_templates": {
                  Row: {
                    "active": boolean,"created_at": string,"created_by_membership_id": string | null,"id": string,"name": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"created_by_membership_id"?: string | null,"id"?: string,"name": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"created_by_membership_id"?: string | null,"id"?: string,"name"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_templates_created_by_fk"
      columns: ["tenant_id","created_by_membership_id"]
isOneToOne: false
      referencedRelation: "tenant_memberships"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "contract_templates_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"contracts": {
                  Row: {
                    "approval_id": string,"balance_cents": number,"balance_due_date": string | null,"booking_policy": string | null,"commercial_snapshot": NonNullable<Json>,"consent_version": string | null,"content_sha256": string,"created_at": string,"currency": string,"deposit_cents": number,"deposit_percent": number,"event_id": string,"generated_by_membership_id": string | null,"generated_by_user_id": string,"id": string,"party_snapshot": NonNullable<Json>,"proposal_id": string,"rendered_content": NonNullable<Json>,"replaces_id": string | null,"selection_id": string,"sent_at": string | null,"signed_at": string | null,"signer_client_id": string,"signer_email": string,"signer_name": string,"signing_mode": string,"status": string,"status_changed_at": string | null,"template_content_sha256": string,"template_id": string,"template_version_id": string,"tenant_id": string,"total_cents": number,"updated_at": string,"void_reason": string | null,"voided_at": string | null
                  }
                  Insert: {
                    "approval_id": string,"balance_cents": number,"balance_due_date"?: string | null,"booking_policy"?: string | null,"commercial_snapshot": NonNullable<Json>,"consent_version"?: string | null,"content_sha256": string,"created_at"?: string,"currency": string,"deposit_cents": number,"deposit_percent": number,"event_id": string,"generated_by_membership_id"?: string | null,"generated_by_user_id": string,"id"?: string,"party_snapshot": NonNullable<Json>,"proposal_id": string,"rendered_content": NonNullable<Json>,"replaces_id"?: string | null,"selection_id": string,"sent_at"?: string | null,"signed_at"?: string | null,"signer_client_id": string,"signer_email": string,"signer_name": string,"signing_mode": string,"status"?: string,"status_changed_at"?: string | null,"template_content_sha256": string,"template_id": string,"template_version_id": string,"tenant_id": string,"total_cents": number,"updated_at"?: string,"void_reason"?: string | null,"voided_at"?: string | null
                  }
                  Update: {
                    "approval_id"?: string,"balance_cents"?: number,"balance_due_date"?: string | null,"booking_policy"?: string | null,"commercial_snapshot"?: NonNullable<Json>,"consent_version"?: string | null,"content_sha256"?: string,"created_at"?: string,"currency"?: string,"deposit_cents"?: number,"deposit_percent"?: number,"event_id"?: string,"generated_by_membership_id"?: string | null,"generated_by_user_id"?: string,"id"?: string,"party_snapshot"?: NonNullable<Json>,"proposal_id"?: string,"rendered_content"?: NonNullable<Json>,"replaces_id"?: string | null,"selection_id"?: string,"sent_at"?: string | null,"signed_at"?: string | null,"signer_client_id"?: string,"signer_email"?: string,"signer_name"?: string,"signing_mode"?: string,"status"?: string,"status_changed_at"?: string | null,"template_content_sha256"?: string,"template_id"?: string,"template_version_id"?: string,"tenant_id"?: string,"total_cents"?: number,"updated_at"?: string,"void_reason"?: string | null,"voided_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "contracts_approval_fk"
      columns: ["tenant_id","proposal_id","selection_id","approval_id"]
isOneToOne: false
      referencedRelation: "proposal_approvals"
      referencedColumns: ["tenant_id","proposal_id","selection_id","id"]
    },{
      foreignKeyName: "contracts_event_fk"
      columns: ["tenant_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "contracts_generated_by_fk"
      columns: ["tenant_id","generated_by_membership_id"]
isOneToOne: false
      referencedRelation: "tenant_memberships"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "contracts_proposal_fk"
      columns: ["tenant_id","event_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","event_id","id"]
    },{
      foreignKeyName: "contracts_replaces_fk"
      columns: ["tenant_id","event_id","replaces_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["tenant_id","event_id","id"]
    },{
      foreignKeyName: "contracts_signer_fk"
      columns: ["tenant_id","signer_client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "contracts_template_version_fk"
      columns: ["tenant_id","template_id","template_version_id"]
isOneToOne: false
      referencedRelation: "contract_template_versions"
      referencedColumns: ["tenant_id","template_id","id"]
    },{
      foreignKeyName: "contracts_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"document_jobs": {
                  Row: {
                    "attempts": number,"completed_at": string | null,"contract_id": string,"created_at": string,"deliver_copies": boolean,"document_id": string | null,"id": string,"kind": string,"last_error": string | null,"lease_token": string | null,"locked_until": string | null,"max_attempts": number,"next_attempt_at": string,"requested_by_user_id": string | null,"status": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "attempts"?: number,"completed_at"?: string | null,"contract_id": string,"created_at"?: string,"deliver_copies": boolean,"document_id"?: string | null,"id"?: string,"kind"?: string,"last_error"?: string | null,"lease_token"?: string | null,"locked_until"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string,"requested_by_user_id"?: string | null,"status"?: string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"completed_at"?: string | null,"contract_id"?: string,"created_at"?: string,"deliver_copies"?: boolean,"document_id"?: string | null,"id"?: string,"kind"?: string,"last_error"?: string | null,"lease_token"?: string | null,"locked_until"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string,"requested_by_user_id"?: string | null,"status"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_jobs_contract_fk"
      columns: ["tenant_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "document_jobs_document_fk"
      columns: ["tenant_id","document_id"]
isOneToOne: false
      referencedRelation: "contract_documents"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "document_jobs_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"email_outbox": {
                  Row: {
                    "access_link_id": string | null,"attempts": number,"created_at": string,"dedup_key": string,"entity_id": string,"entity_type": string,"event_type": string,"id": string,"last_error": string | null,"locked_until": string | null,"max_attempts": number,"next_attempt_at": string,"payload": NonNullable<Json>,"provider_message_id": string | null,"recipient_email": string,"sender": Json | null,"sent_at": string | null,"status": string,"tenant_id": string | null,"updated_at": string
                  }
                  Insert: {
                    "access_link_id"?: string | null,"attempts"?: number,"created_at"?: string,"dedup_key": string,"entity_id": string,"entity_type"?: string,"event_type": string,"id"?: string,"last_error"?: string | null,"locked_until"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string,"payload"?: NonNullable<Json>,"provider_message_id"?: string | null,"recipient_email": string,"sender"?: Json | null,"sent_at"?: string | null,"status"?: string,"tenant_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "access_link_id"?: string | null,"attempts"?: number,"created_at"?: string,"dedup_key"?: string,"entity_id"?: string,"entity_type"?: string,"event_type"?: string,"id"?: string,"last_error"?: string | null,"locked_until"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string,"payload"?: NonNullable<Json>,"provider_message_id"?: string | null,"recipient_email"?: string,"sender"?: Json | null,"sent_at"?: string | null,"status"?: string,"tenant_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_outbox_link_fk"
      columns: ["tenant_id","access_link_id"]
isOneToOne: false
      referencedRelation: "access_links"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "email_outbox_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"event_access": {
                  Row: {
                    "client_id": string,"created_at": string,"event_id": string,"id": string,"revoked_at": string | null,"tenant_id": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "client_id": string,"created_at"?: string,"event_id": string,"id"?: string,"revoked_at"?: string | null,"tenant_id": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "client_id"?: string,"created_at"?: string,"event_id"?: string,"id"?: string,"revoked_at"?: string | null,"tenant_id"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_access_client_fk"
      columns: ["tenant_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_access_event_client_fk"
      columns: ["tenant_id","event_id","client_id"]
isOneToOne: false
      referencedRelation: "event_clients"
      referencedColumns: ["tenant_id","event_id","client_id"]
    },{
      foreignKeyName: "event_access_event_fk"
      columns: ["tenant_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_access_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"event_billing": {
                  Row: {
                    "created_at": string,"event_id": string,"invoice_url": string | null,"tenant_id": string,"updated_at": string,"updated_by_user_id": string | null,"version": number
                  }
                  Insert: {
                    "created_at"?: string,"event_id": string,"invoice_url"?: string | null,"tenant_id": string,"updated_at"?: string,"updated_by_user_id"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"event_id"?: string,"invoice_url"?: string | null,"tenant_id"?: string,"updated_at"?: string,"updated_by_user_id"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_billing_event_fk"
      columns: ["tenant_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_billing_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"event_clients": {
                  Row: {
                    "can_sign": boolean,"client_id": string,"created_at": string,"event_id": string,"id": string,"is_primary": boolean,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "can_sign"?: boolean,"client_id": string,"created_at"?: string,"event_id": string,"id"?: string,"is_primary"?: boolean,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "can_sign"?: boolean,"client_id"?: string,"created_at"?: string,"event_id"?: string,"id"?: string,"is_primary"?: boolean,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_clients_client_fk"
      columns: ["tenant_id","client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_clients_event_fk"
      columns: ["tenant_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_clients_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"event_payments": {
                  Row: {
                    "amount_cents": number,"created_at": string,"currency": string,"event_id": string,"id": string,"idempotency_key": string,"invalidated_at": string | null,"invalidated_by_email": string | null,"invalidated_by_membership_id": string | null,"invalidated_by_user_id": string | null,"invalidation_reason": string | null,"note": string | null,"paid_on": string,"recorded_by_email": string | null,"recorded_by_membership_id": string | null,"recorded_by_user_id": string,"reference": string | null,"tenant_id": string
                  }
                  Insert: {
                    "amount_cents": number,"created_at"?: string,"currency": string,"event_id": string,"id"?: string,"idempotency_key": string,"invalidated_at"?: string | null,"invalidated_by_email"?: string | null,"invalidated_by_membership_id"?: string | null,"invalidated_by_user_id"?: string | null,"invalidation_reason"?: string | null,"note"?: string | null,"paid_on": string,"recorded_by_email"?: string | null,"recorded_by_membership_id"?: string | null,"recorded_by_user_id": string,"reference"?: string | null,"tenant_id": string
                  }
                  Update: {
                    "amount_cents"?: number,"created_at"?: string,"currency"?: string,"event_id"?: string,"id"?: string,"idempotency_key"?: string,"invalidated_at"?: string | null,"invalidated_by_email"?: string | null,"invalidated_by_membership_id"?: string | null,"invalidated_by_user_id"?: string | null,"invalidation_reason"?: string | null,"note"?: string | null,"paid_on"?: string,"recorded_by_email"?: string | null,"recorded_by_membership_id"?: string | null,"recorded_by_user_id"?: string,"reference"?: string | null,"tenant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_payments_event_fk"
      columns: ["tenant_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_payments_invalidated_by_fk"
      columns: ["tenant_id","invalidated_by_membership_id"]
isOneToOne: false
      referencedRelation: "tenant_memberships"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_payments_recorded_by_fk"
      columns: ["tenant_id","recorded_by_membership_id"]
isOneToOne: false
      referencedRelation: "tenant_memberships"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_payments_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"event_plan_imports": {
                  Row: {
                    "answers": NonNullable<Json>,"captured_at": string,"contract_id": string,"id": string,"offer_sha256": string,"plan_id": string,"proposal_id": string,"questions": NonNullable<Json>,"selection_id": string,"source": string,"tenant_id": string
                  }
                  Insert: {
                    "answers": NonNullable<Json>,"captured_at"?: string,"contract_id": string,"id"?: string,"offer_sha256": string,"plan_id": string,"proposal_id": string,"questions": NonNullable<Json>,"selection_id": string,"source"?: string,"tenant_id": string
                  }
                  Update: {
                    "answers"?: NonNullable<Json>,"captured_at"?: string,"contract_id"?: string,"id"?: string,"offer_sha256"?: string,"plan_id"?: string,"proposal_id"?: string,"questions"?: NonNullable<Json>,"selection_id"?: string,"source"?: string,"tenant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_plan_imports_contract_fk"
      columns: ["tenant_id","contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_plan_imports_plan_fk"
      columns: ["tenant_id","plan_id"]
isOneToOne: false
      referencedRelation: "event_plans"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_plan_imports_proposal_fk"
      columns: ["tenant_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_plan_imports_selection_fk"
      columns: ["tenant_id","selection_id"]
isOneToOne: false
      referencedRelation: "proposal_selections"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_plan_imports_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"event_plan_items": {
                  Row: {
                    "created_at": string,"disabled_at": string | null,"id": string,"key": string,"kind": string,"label": string,"parent_id": string | null,"plan_id": string,"position": number,"source_template_item_id": string | null,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"disabled_at"?: string | null,"id"?: string,"key": string,"kind": string,"label": string,"parent_id"?: string | null,"plan_id": string,"position": number,"source_template_item_id"?: string | null,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"disabled_at"?: string | null,"id"?: string,"key"?: string,"kind"?: string,"label"?: string,"parent_id"?: string | null,"plan_id"?: string,"position"?: number,"source_template_item_id"?: string | null,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_plan_items_parent_fk"
      columns: ["tenant_id","plan_id","parent_id"]
isOneToOne: false
      referencedRelation: "event_plan_items"
      referencedColumns: ["tenant_id","plan_id","id"]
    },{
      foreignKeyName: "event_plan_items_plan_fk"
      columns: ["tenant_id","plan_id"]
isOneToOne: false
      referencedRelation: "event_plans"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_plan_items_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"event_plan_responses": {
                  Row: {
                    "answers": NonNullable<Json>,"created_at": string,"id": string,"item_id": string,"plan_id": string,"revision": number,"schema_version": number,"tenant_id": string,"updated_at": string,"updated_by_actor": string,"updated_by_user_id": string | null
                  }
                  Insert: {
                    "answers"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"item_id": string,"plan_id": string,"revision"?: number,"schema_version"?: number,"tenant_id": string,"updated_at"?: string,"updated_by_actor": string,"updated_by_user_id"?: string | null
                  }
                  Update: {
                    "answers"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"item_id"?: string,"plan_id"?: string,"revision"?: number,"schema_version"?: number,"tenant_id"?: string,"updated_at"?: string,"updated_by_actor"?: string,"updated_by_user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_plan_responses_item_fk"
      columns: ["tenant_id","plan_id","item_id"]
isOneToOne: false
      referencedRelation: "event_plan_items"
      referencedColumns: ["tenant_id","plan_id","id"]
    },{
      foreignKeyName: "event_plan_responses_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"event_plans": {
                  Row: {
                    "client_cutoff_days": number,"client_cutoff_version": number,"created_at": string,"event_id": string,"id": string,"initialized_via": string,"origin": string,"source_template_id": string | null,"source_template_name": string | null,"source_template_version": number | null,"structure_version": number,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "client_cutoff_days": number,"client_cutoff_version"?: number,"created_at"?: string,"event_id": string,"id"?: string,"initialized_via": string,"origin": string,"source_template_id"?: string | null,"source_template_name"?: string | null,"source_template_version"?: number | null,"structure_version"?: number,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "client_cutoff_days"?: number,"client_cutoff_version"?: number,"created_at"?: string,"event_id"?: string,"id"?: string,"initialized_via"?: string,"origin"?: string,"source_template_id"?: string | null,"source_template_name"?: string | null,"source_template_version"?: number | null,"structure_version"?: number,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_plans_event_fk"
      columns: ["tenant_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_plans_template_fk"
      columns: ["tenant_id","source_template_id"]
isOneToOne: false
      referencedRelation: "planning_templates"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "event_plans_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"events": {
                  Row: {
                    "active_proposal_id": string | null,"archived_at": string | null,"booking_confirmed_at": string | null,"created_at": string,"event_date": string,"event_type": string,"id": string,"internal_notes": string | null,"lifecycle_status": string,"planning_lock_at": string | null,"planning_override_until": string | null,"tenant_id": string,"timezone": string,"title": string,"updated_at": string,"venue_address": string | null,"venue_name": string | null
                  }
                  Insert: {
                    "active_proposal_id"?: string | null,"archived_at"?: string | null,"booking_confirmed_at"?: string | null,"created_at"?: string,"event_date": string,"event_type": string,"id"?: string,"internal_notes"?: string | null,"lifecycle_status"?: string,"planning_lock_at"?: string | null,"planning_override_until"?: string | null,"tenant_id": string,"timezone"?: string,"title": string,"updated_at"?: string,"venue_address"?: string | null,"venue_name"?: string | null
                  }
                  Update: {
                    "active_proposal_id"?: string | null,"archived_at"?: string | null,"booking_confirmed_at"?: string | null,"created_at"?: string,"event_date"?: string,"event_type"?: string,"id"?: string,"internal_notes"?: string | null,"lifecycle_status"?: string,"planning_lock_at"?: string | null,"planning_override_until"?: string | null,"tenant_id"?: string,"timezone"?: string,"title"?: string,"updated_at"?: string,"venue_address"?: string | null,"venue_name"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "events_active_proposal_fk"
      columns: ["tenant_id","active_proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "events_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"gear_items": {
                  Row: {
                    "active": boolean,"created_at": string,"default_price_cents": number,"description": string | null,"id": string,"key": string,"name": string,"tax_category": string,"tenant_id": string,"unit_label": string,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"default_price_cents": number,"description"?: string | null,"id"?: string,"key": string,"name": string,"tax_category"?: string,"tenant_id": string,"unit_label"?: string,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"default_price_cents"?: number,"description"?: string | null,"id"?: string,"key"?: string,"name"?: string,"tax_category"?: string,"tenant_id"?: string,"unit_label"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "gear_items_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"gear_media": {
                  Row: {
                    "active": boolean,"alt_text": string,"content_type": string,"created_at": string,"gear_item_id": string,"id": string,"kind": string,"sort_order": number,"storage_path": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"alt_text": string,"content_type": string,"created_at"?: string,"gear_item_id": string,"id"?: string,"kind": string,"sort_order"?: number,"storage_path": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"alt_text"?: string,"content_type"?: string,"created_at"?: string,"gear_item_id"?: string,"id"?: string,"kind"?: string,"sort_order"?: number,"storage_path"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "gear_media_gear_item_fk"
      columns: ["tenant_id","gear_item_id"]
isOneToOne: false
      referencedRelation: "gear_items"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "gear_media_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"logistics_questions": {
                  Row: {
                    "active": boolean,"answer_type": string,"created_at": string,"id": string,"key": string,"options": NonNullable<Json>,"prompt": string,"required": boolean,"sort_order": number,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"answer_type": string,"created_at"?: string,"id"?: string,"key": string,"options"?: NonNullable<Json>,"prompt": string,"required"?: boolean,"sort_order"?: number,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"answer_type"?: string,"created_at"?: string,"id"?: string,"key"?: string,"options"?: NonNullable<Json>,"prompt"?: string,"required"?: boolean,"sort_order"?: number,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "logistics_questions_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"logistics_rules": {
                  Row: {
                    "active": boolean,"condition": NonNullable<Json>,"created_at": string,"gear_item_id": string,"id": string,"question_id": string,"reason": string,"required_quantity": number,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"condition": NonNullable<Json>,"created_at"?: string,"gear_item_id": string,"id"?: string,"question_id": string,"reason": string,"required_quantity": number,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"condition"?: NonNullable<Json>,"created_at"?: string,"gear_item_id"?: string,"id"?: string,"question_id"?: string,"reason"?: string,"required_quantity"?: number,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "logistics_rules_gear_item_fk"
      columns: ["tenant_id","gear_item_id"]
isOneToOne: false
      referencedRelation: "gear_items"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "logistics_rules_question_fk"
      columns: ["tenant_id","question_id"]
isOneToOne: false
      referencedRelation: "logistics_questions"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "logistics_rules_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"package_items": {
                  Row: {
                    "created_at": string,"gear_item_id": string,"id": string,"package_id": string,"quantity": number,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"gear_item_id": string,"id"?: string,"package_id": string,"quantity": number,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"gear_item_id"?: string,"id"?: string,"package_id"?: string,"quantity"?: number,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "package_items_gear_item_fk"
      columns: ["tenant_id","gear_item_id"]
isOneToOne: false
      referencedRelation: "gear_items"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "package_items_package_fk"
      columns: ["tenant_id","package_id"]
isOneToOne: false
      referencedRelation: "packages"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "package_items_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"packages": {
                  Row: {
                    "active": boolean,"base_price_cents": number,"created_at": string,"description": string | null,"id": string,"is_popular": boolean,"key": string,"name": string,"sort_order": number,"tax_category": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"base_price_cents": number,"created_at"?: string,"description"?: string | null,"id"?: string,"is_popular"?: boolean,"key": string,"name": string,"sort_order"?: number,"tax_category"?: string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"base_price_cents"?: number,"created_at"?: string,"description"?: string | null,"id"?: string,"is_popular"?: boolean,"key"?: string,"name"?: string,"sort_order"?: number,"tax_category"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "packages_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"planning_template_items": {
                  Row: {
                    "created_at": string,"id": string,"key": string,"kind": string,"label": string,"parent_id": string | null,"position": number,"template_id": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"key": string,"kind": string,"label": string,"parent_id"?: string | null,"position": number,"template_id": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"key"?: string,"kind"?: string,"label"?: string,"parent_id"?: string | null,"position"?: number,"template_id"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "planning_template_items_parent_fk"
      columns: ["tenant_id","template_id","parent_id"]
isOneToOne: false
      referencedRelation: "planning_template_items"
      referencedColumns: ["tenant_id","template_id","id"]
    },{
      foreignKeyName: "planning_template_items_template_fk"
      columns: ["tenant_id","template_id"]
isOneToOne: false
      referencedRelation: "planning_templates"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "planning_template_items_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"planning_templates": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"default_event_type": string | null,"description": string | null,"id": string,"name": string,"starter_key": string | null,"tenant_id": string,"updated_at": string,"version": number
                  }
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"default_event_type"?: string | null,"description"?: string | null,"id"?: string,"name": string,"starter_key"?: string | null,"tenant_id": string,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"default_event_type"?: string | null,"description"?: string | null,"id"?: string,"name"?: string,"starter_key"?: string | null,"tenant_id"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "planning_templates_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"platform_admins": {
                  Row: {
                    "granted_at": string,"note": string,"user_id": string
                  }
                  Insert: {
                    "granted_at"?: string,"note": string,"user_id": string
                  }
                  Update: {
                    "granted_at"?: string,"note"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"platform_audit_events": {
                  Row: {
                    "action": string,"actor_id": string | null,"entity_id": string,"entity_type": string,"id": string,"metadata": NonNullable<Json>,"occurred_at": string
                  }
                  Insert: {
                    "action": string,"actor_id"?: string | null,"entity_id": string,"entity_type": string,"id"?: string,"metadata"?: NonNullable<Json>,"occurred_at"?: string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"entity_id"?: string,"entity_type"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"occurred_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"platform_invitations": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"email": string,"expires_at": string,"id": string,"invited_by": string | null,"last_sent_at": string,"link_id": string,"revoked_at": string | null,"revoked_by": string | null,"send_count": number,"tenant_id": string | null,"token_hash": string,"updated_at": string
                  }
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email": string,"expires_at": string,"id"?: string,"invited_by"?: string | null,"last_sent_at"?: string,"link_id": string,"revoked_at"?: string | null,"revoked_by"?: string | null,"send_count"?: number,"tenant_id"?: string | null,"token_hash": string,"updated_at"?: string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"last_sent_at"?: string,"link_id"?: string,"revoked_at"?: string | null,"revoked_by"?: string | null,"send_count"?: number,"tenant_id"?: string | null,"token_hash"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "platform_invitations_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: true
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_approvals": {
                  Row: {
                    "approved_at": string,"approved_by_membership_id": string | null,"approved_by_user_id": string,"created_at": string,"id": string,"proposal_id": string,"selection_id": string,"selection_sha256": string,"tenant_id": string
                  }
                  Insert: {
                    "approved_at"?: string,"approved_by_membership_id"?: string | null,"approved_by_user_id": string,"created_at"?: string,"id"?: string,"proposal_id": string,"selection_id": string,"selection_sha256": string,"tenant_id": string
                  }
                  Update: {
                    "approved_at"?: string,"approved_by_membership_id"?: string | null,"approved_by_user_id"?: string,"created_at"?: string,"id"?: string,"proposal_id"?: string,"selection_id"?: string,"selection_sha256"?: string,"tenant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_approvals_membership_fk"
      columns: ["tenant_id","approved_by_membership_id"]
isOneToOne: false
      referencedRelation: "tenant_memberships"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_approvals_selection_fk"
      columns: ["tenant_id","proposal_id","selection_id"]
isOneToOne: false
      referencedRelation: "proposal_selections"
      referencedColumns: ["tenant_id","proposal_id","id"]
    },{
      foreignKeyName: "proposal_approvals_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_selection_drafts": {
                  Row: {
                    "addon_quantities": NonNullable<Json>,"created_at": string,"id": string,"logistics_answers": NonNullable<Json>,"package_key": string | null,"proposal_id": string,"tenant_id": string,"updated_at": string,"version": number
                  }
                  Insert: {
                    "addon_quantities"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"logistics_answers"?: NonNullable<Json>,"package_key"?: string | null,"proposal_id": string,"tenant_id": string,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "addon_quantities"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"logistics_answers"?: NonNullable<Json>,"package_key"?: string | null,"proposal_id"?: string,"tenant_id"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_selection_drafts_proposal_fk"
      columns: ["tenant_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_selection_drafts_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_selection_lines": {
                  Row: {
                    "created_at": string,"description": string | null,"id": string,"item_key": string,"line_no": number,"line_total_cents": number,"name": string,"quantity": number,"required_quantity": number,"required_reasons": (string)[],"selection_id": string,"source": string,"tax_category": string,"tenant_id": string,"unit_price_cents": number
                  }
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"item_key": string,"line_no": number,"line_total_cents": number,"name": string,"quantity": number,"required_quantity"?: number,"required_reasons"?: (string)[],"selection_id": string,"source": string,"tax_category": string,"tenant_id": string,"unit_price_cents": number
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"item_key"?: string,"line_no"?: number,"line_total_cents"?: number,"name"?: string,"quantity"?: number,"required_quantity"?: number,"required_reasons"?: (string)[],"selection_id"?: string,"source"?: string,"tax_category"?: string,"tenant_id"?: string,"unit_price_cents"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_selection_lines_selection_fk"
      columns: ["tenant_id","selection_id"]
isOneToOne: false
      referencedRelation: "proposal_selections"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_selection_lines_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_selections": {
                  Row: {
                    "addon_quantities": NonNullable<Json>,"created_at": string,"currency": string,"id": string,"idempotency_key": string | null,"logistics_answers": NonNullable<Json>,"offer_sha256": string,"package_key": string,"pricing_version": string,"proposal_id": string,"selection_snapshot": NonNullable<Json>,"submitted_at": string | null,"subtotal_cents": number,"tax_breakdown": NonNullable<Json>,"tax_cents": number,"tenant_id": string,"total_cents": number,"updated_at": string,"version": number
                  }
                  Insert: {
                    "addon_quantities": NonNullable<Json>,"created_at"?: string,"currency": string,"id"?: string,"idempotency_key"?: string | null,"logistics_answers": NonNullable<Json>,"offer_sha256": string,"package_key": string,"pricing_version": string,"proposal_id": string,"selection_snapshot": NonNullable<Json>,"submitted_at"?: string | null,"subtotal_cents": number,"tax_breakdown": NonNullable<Json>,"tax_cents": number,"tenant_id": string,"total_cents": number,"updated_at"?: string,"version": number
                  }
                  Update: {
                    "addon_quantities"?: NonNullable<Json>,"created_at"?: string,"currency"?: string,"id"?: string,"idempotency_key"?: string | null,"logistics_answers"?: NonNullable<Json>,"offer_sha256"?: string,"package_key"?: string,"pricing_version"?: string,"proposal_id"?: string,"selection_snapshot"?: NonNullable<Json>,"submitted_at"?: string | null,"subtotal_cents"?: number,"tax_breakdown"?: NonNullable<Json>,"tax_cents"?: number,"tenant_id"?: string,"total_cents"?: number,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_selections_proposal_fk"
      columns: ["tenant_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_selections_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_sessions": {
                  Row: {
                    "access_link_id": string,"created_at": string,"expires_at": string,"id": string,"proposal_id": string,"revoked_at": string | null,"session_hash": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "access_link_id": string,"created_at"?: string,"expires_at": string,"id"?: string,"proposal_id": string,"revoked_at"?: string | null,"session_hash": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "access_link_id"?: string,"created_at"?: string,"expires_at"?: string,"id"?: string,"proposal_id"?: string,"revoked_at"?: string | null,"session_hash"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_sessions_link_fk"
      columns: ["tenant_id","access_link_id"]
isOneToOne: false
      referencedRelation: "access_links"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_sessions_proposal_fk"
      columns: ["tenant_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_sessions_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_template_addons": {
                  Row: {
                    "created_at": string,"gear_item_id": string,"id": string,"max_quantity": number,"recommended_quantity": number,"sort_order": number,"template_id": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"gear_item_id": string,"id"?: string,"max_quantity": number,"recommended_quantity"?: number,"sort_order"?: number,"template_id": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"gear_item_id"?: string,"id"?: string,"max_quantity"?: number,"recommended_quantity"?: number,"sort_order"?: number,"template_id"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_template_addons_gear_item_fk"
      columns: ["tenant_id","gear_item_id"]
isOneToOne: false
      referencedRelation: "gear_items"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_template_addons_template_fk"
      columns: ["tenant_id","template_id"]
isOneToOne: false
      referencedRelation: "proposal_templates"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_template_addons_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_template_packages": {
                  Row: {
                    "created_at": string,"id": string,"package_id": string,"sort_order": number,"template_id": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"package_id": string,"sort_order": number,"template_id": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"package_id"?: string,"sort_order"?: number,"template_id"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_template_packages_package_fk"
      columns: ["tenant_id","package_id"]
isOneToOne: false
      referencedRelation: "packages"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_template_packages_template_fk"
      columns: ["tenant_id","template_id"]
isOneToOne: false
      referencedRelation: "proposal_templates"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_template_packages_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_template_questions": {
                  Row: {
                    "created_at": string,"id": string,"question_id": string,"sort_order": number,"template_id": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"question_id": string,"sort_order"?: number,"template_id": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"question_id"?: string,"sort_order"?: number,"template_id"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_template_questions_question_fk"
      columns: ["tenant_id","question_id"]
isOneToOne: false
      referencedRelation: "logistics_questions"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_template_questions_template_fk"
      columns: ["tenant_id","template_id"]
isOneToOne: false
      referencedRelation: "proposal_templates"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_template_questions_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_templates": {
                  Row: {
                    "active": boolean,"created_at": string,"default_package_id": string | null,"expiry_days": number,"id": string,"intro": string | null,"name": string,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"default_package_id"?: string | null,"expiry_days"?: number,"id"?: string,"intro"?: string | null,"name": string,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"default_package_id"?: string | null,"expiry_days"?: number,"id"?: string,"intro"?: string | null,"name"?: string,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_templates_default_package_fk"
      columns: ["tenant_id","id","default_package_id"]
isOneToOne: false
      referencedRelation: "proposal_template_packages"
      referencedColumns: ["tenant_id","template_id","package_id"]
    },{
      foreignKeyName: "proposal_templates_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposal_views": {
                  Row: {
                    "access_link_id": string,"id": string,"kind": string,"opened_at": string,"proposal_id": string,"tenant_id": string
                  }
                  Insert: {
                    "access_link_id": string,"id"?: string,"kind"?: string,"opened_at"?: string,"proposal_id": string,"tenant_id": string
                  }
                  Update: {
                    "access_link_id"?: string,"id"?: string,"kind"?: string,"opened_at"?: string,"proposal_id"?: string,"tenant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_views_link_fk"
      columns: ["tenant_id","access_link_id"]
isOneToOne: false
      referencedRelation: "access_links"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_views_proposal_fk"
      columns: ["tenant_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposal_views_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"proposals": {
                  Row: {
                    "created_at": string,"created_by_membership_id": string | null,"current_selection_version": number,"draft_offer": NonNullable<Json>,"draft_version": number,"event_id": string,"expires_at": string | null,"first_viewed_at": string | null,"id": string,"offer_frozen_at": string | null,"offer_sha256": string | null,"offer_snapshot": Json | null,"revision": number,"sent_at": string | null,"source_template_id": string | null,"status": string,"supersedes_id": string | null,"tenant_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"created_by_membership_id"?: string | null,"current_selection_version"?: number,"draft_offer"?: NonNullable<Json>,"draft_version"?: number,"event_id": string,"expires_at"?: string | null,"first_viewed_at"?: string | null,"id"?: string,"offer_frozen_at"?: string | null,"offer_sha256"?: string | null,"offer_snapshot"?: Json | null,"revision": number,"sent_at"?: string | null,"source_template_id"?: string | null,"status"?: string,"supersedes_id"?: string | null,"tenant_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by_membership_id"?: string | null,"current_selection_version"?: number,"draft_offer"?: NonNullable<Json>,"draft_version"?: number,"event_id"?: string,"expires_at"?: string | null,"first_viewed_at"?: string | null,"id"?: string,"offer_frozen_at"?: string | null,"offer_sha256"?: string | null,"offer_snapshot"?: Json | null,"revision"?: number,"sent_at"?: string | null,"source_template_id"?: string | null,"status"?: string,"supersedes_id"?: string | null,"tenant_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposals_created_by_fk"
      columns: ["tenant_id","created_by_membership_id"]
isOneToOne: false
      referencedRelation: "tenant_memberships"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposals_event_fk"
      columns: ["tenant_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposals_supersedes_fk"
      columns: ["tenant_id","supersedes_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposals_template_fk"
      columns: ["tenant_id","source_template_id"]
isOneToOne: false
      referencedRelation: "proposal_templates"
      referencedColumns: ["tenant_id","id"]
    },{
      foreignKeyName: "proposals_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_logos": {
                  Row: {
                    "byte_size": number,"created_at": string,"height": number,"id": string,"needs_dark_background": boolean,"sha256": string,"storage_path": string,"tenant_id": string,"uploaded_by": string,"width": number
                  }
                  Insert: {
                    "byte_size": number,"created_at"?: string,"height": number,"id"?: string,"needs_dark_background": boolean,"sha256": string,"storage_path": string,"tenant_id": string,"uploaded_by": string,"width": number
                  }
                  Update: {
                    "byte_size"?: number,"created_at"?: string,"height"?: number,"id"?: string,"needs_dark_background"?: boolean,"sha256"?: string,"storage_path"?: string,"tenant_id"?: string,"uploaded_by"?: string,"width"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_logos_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_memberships": {
                  Row: {
                    "created_at": string,"id": string,"role": string,"tenant_id": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"role": string,"tenant_id": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"role"?: string,"tenant_id"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_memberships_tenant_id_fkey"
      columns: ["tenant_id"]
isOneToOne: false
      referencedRelation: "tenants"
      referencedColumns: ["id"]
    }
                  ]
                },"tenants": {
                  Row: {
                    "archived_at": string | null,"booking_confirmation_policy": string,"booking_policy_version": number,"brand_colors": NonNullable<Json>,"branding_version": number,"business_address": string | null,"business_name": string,"contact_email": string | null,"created_at": string,"currency": string,"deposit_percent": number,"display_name": string,"id": string,"logo_storage_path": string | null,"planning_lock_days": number,"planning_settings_version": number,"reply_to_email": string | null,"slug": string,"suspended_at": string | null,"suspension_version": number,"tax_categories": NonNullable<Json>,"tax_config": NonNullable<Json>,"tax_settings_version": number,"timezone": string,"updated_at": string
                  }
                  Insert: {
                    "archived_at"?: string | null,"booking_confirmation_policy"?: string,"booking_policy_version"?: number,"brand_colors"?: NonNullable<Json>,"branding_version"?: number,"business_address"?: string | null,"business_name": string,"contact_email"?: string | null,"created_at"?: string,"currency"?: string,"deposit_percent"?: number,"display_name": string,"id"?: string,"logo_storage_path"?: string | null,"planning_lock_days"?: number,"planning_settings_version"?: number,"reply_to_email"?: string | null,"slug": string,"suspended_at"?: string | null,"suspension_version"?: number,"tax_categories"?: NonNullable<Json>,"tax_config"?: NonNullable<Json>,"tax_settings_version"?: number,"timezone"?: string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"booking_confirmation_policy"?: string,"booking_policy_version"?: number,"brand_colors"?: NonNullable<Json>,"branding_version"?: number,"business_address"?: string | null,"business_name"?: string,"contact_email"?: string | null,"created_at"?: string,"currency"?: string,"deposit_percent"?: number,"display_name"?: string,"id"?: string,"logo_storage_path"?: string | null,"planning_lock_days"?: number,"planning_settings_version"?: number,"reply_to_email"?: string | null,"slug"?: string,"suspended_at"?: string | null,"suspension_version"?: number,"tax_categories"?: NonNullable<Json>,"tax_config"?: NonNullable<Json>,"tax_settings_version"?: number,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenants_logo_registered"
      columns: ["id","logo_storage_path"]
isOneToOne: false
      referencedRelation: "tenant_logos"
      referencedColumns: ["tenant_id","storage_path"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_contract_invitation":
{ Args: { "p_link_id": string,"p_tenant_slug": string }; Returns: Json
                           },
"accept_platform_invitation":
{ Args: { "p_display_name": string,"p_invitation_id": string,"p_slug": string }; Returns: Json
                           },
"add_event_plan_item":
{ Args: { "p_event_id": string,"p_expected_version": number,"p_key": string,"p_parent_key": string }; Returns: number
                           },
"add_planning_template_item":
{ Args: { "p_expected_version": number,"p_key": string,"p_parent_key": string,"p_template_id": string }; Returns: number
                           },
"apply_event_plan_template":
{ Args: { "p_confirm": boolean,"p_event_id": string,"p_expected_version": number,"p_template_id": string }; Returns: Json
                           },
"approve_proposal_selection":
{ Args: { "p_proposal_id": string,"p_selection_id": string }; Returns: Json
                           },
"cancel_email_outbox":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"check_event_booking":
{ Args: { "p_event_id": string }; Returns: Json
                           },
"claim_document_jobs":
{ Args: { "p_contract_id"?: string,"p_lease_seconds"?: number,"p_limit"?: number,"p_tenant_id"?: string }; Returns: {
              "attempts": number,"contract_id": string,"deliver_copies": boolean,"job_id": string,"lease_token": string,"max_attempts": number,"tenant_id": string
            }[]
                           },
"claim_email_outbox":
{ Args: { "p_include_booking"?: boolean,"p_limit"?: number,"p_lock_seconds"?: number,"p_tenant_id"?: string }; Returns: {
              "access_link_id": string,"attempts": number,"contract_deliverable": boolean,"contract_id": string,"entity_id": string,"event_type": string,"id": string,"link_token_hash": string,"link_usable": boolean,"payload": Json,"proposal_active": boolean,"recipient_email": string,"tenant_display_name": string,"tenant_id": string,"tenant_reply_to": string,"tenant_slug": string
            }[]
                           },
"claim_platform_email_outbox":
{ Args: { "p_invitation_id"?: string,"p_limit"?: number,"p_lock_seconds"?: number }; Returns: {
              "attempts": number,"deliverable": boolean,"event_type": string,"id": string,"invitation_id": string,"link_id": string,"payload": Json,"recipient_email": string,"token_hash": string
            }[]
                           },
"client_contract_view":
{ Args: { "p_contract_id": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_invitation_status":
{ Args: { "p_link_id": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_payment_summary":
{ Args: { "p_contract_id": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_planning_view":
{ Args: { "p_event_id": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_proposal_view":
{ Args: { "p_proposal_id": string,"p_session_hash": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_save_plan_basics":
{ Args: { "p_answers": Json,"p_event_id": string,"p_expected_revision": number,"p_tenant_slug": string }; Returns: Json
                           },
"client_save_plan_item":
{ Args: { "p_answers": Json,"p_event_id": string,"p_expected_revision": number,"p_item_id": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_save_selection_draft":
{ Args: { "p_addon_quantities": Json,"p_expected_version": number,"p_logistics_answers": Json,"p_package_key": string,"p_proposal_id": string,"p_session_hash": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_signature_object":
{ Args: { "p_contract_id": string,"p_tenant_slug": string }; Returns: string
                           },
"client_signed_document":
{ Args: { "p_contract_id": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_submit_selection":
{ Args: { "p_expected_draft_version": number,"p_idempotency_key": string,"p_proposal_id": string,"p_selection": Json,"p_session_hash": string,"p_tenant_slug": string }; Returns: Json
                           },
"client_use_statement_current":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"close_plan_client_editing":
{ Args: { "p_event_id": string,"p_expected_version": number,"p_reason": string }; Returns: Json
                           },
"commit_contract_document":
{ Args: { "p_byte_size": number,"p_job_id": string,"p_pdf_sha256": string,"p_renderer": string,"p_signature_sha256": string,"p_storage_path": string }; Returns: Json
                           },
"complete_email_outbox":
{ Args: { "p_id": string,"p_provider_message_id": string }; Returns: undefined
                           },
"consume_rate_limit":
{ Args: { "p_bucket": string,"p_limit": number,"p_subject_hash": string,"p_window_seconds": number }; Returns: boolean
                           },
"contract_placeholder_catalog":
{ Args: Record<PropertyKey, never>; Returns: {
              "description": string,"key": string,"label": string,"sort_order": number
            }[]
                           },
"create_contract_template":
{ Args: { "p_name": string,"p_sections": Json,"p_tenant_id": string,"p_title": string }; Returns: string
                           },
"create_package":
{ Args: { "p_base_price_cents": number,"p_description": string,"p_items": Json,"p_key": string,"p_name": string,"p_package_id": string,"p_sort_order": number,"p_tax_category": string,"p_tenant_id": string }; Returns: Json
                           },
"create_planning_template":
{ Args: { "p_description": string,"p_name": string,"p_tenant_id": string }; Returns: string
                           },
"create_platform_invitation":
{ Args: { "p_email": string,"p_link_id": string,"p_token_hash": string }; Returns: Json
                           },
"create_proposal_template":
{ Args: { "p_addons": Json,"p_default_package_id": string,"p_expiry_days": number,"p_intro": string,"p_name": string,"p_package_ids": Json,"p_question_ids": Json,"p_template_id": string,"p_tenant_id": string }; Returns: Json
                           },
"current_user_is_platform_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"duplicate_planning_template":
{ Args: { "p_name": string,"p_template_id": string }; Returns: string
                           },
"email_outbox_dispatch_allowed":
{ Args: { "p_id": string }; Returns: boolean
                           },
"event_payment_summary":
{ Args: { "p_event_id": string }; Returns: Json
                           },
"exchange_proposal_link":
{ Args: { "p_session_hash": string,"p_session_seconds": number,"p_tenant_slug": string,"p_token_hash": string }; Returns: Json
                           },
"fail_document_job":
{ Args: { "p_error": string,"p_job_id": string,"p_lease_token": string,"p_permanent"?: boolean }; Returns: boolean
                           },
"fail_email_outbox":
{ Args: { "p_error": string,"p_id": string,"p_permanent"?: boolean }; Returns: undefined
                           },
"freeze_email_sender":
{ Args: { "p_from_address": string,"p_id": string }; Returns: Json
                           },
"generate_contract_draft":
{ Args: { "p_approval_id": string,"p_balance_due_date"?: string,"p_replace_contract_id"?: string,"p_template_version_id": string }; Returns: Json
                           },
"install_starter_planning_templates":
{ Args: { "p_tenant_id": string }; Returns: Json
                           },
"invalidate_event_payment":
{ Args: { "p_payment_id": string,"p_reason": string }; Returns: Json
                           },
"move_event_plan_item":
{ Args: { "p_direction": string,"p_expected_version": number,"p_item_id": string }; Returns: number
                           },
"move_planning_template_item":
{ Args: { "p_direction": string,"p_expected_version": number,"p_item_id": string }; Returns: number
                           },
"my_contracts":
{ Args: Record<PropertyKey, never>; Returns: {
              "contract_id": string,"event_date": string,"event_title": string,"sent_at": string,"signed_at": string,"status": string,"tenant_display_name": string,"tenant_slug": string
            }[]
                           },
"my_events":
{ Args: Record<PropertyKey, never>; Returns: {
              "event_date": string,"event_id": string,"event_type": string,"lifecycle_status": string,"tenant_display_name": string,"tenant_slug": string,"timezone": string,"title": string,"venue_address": string,"venue_name": string
            }[]
                           },
"my_plans":
{ Args: Record<PropertyKey, never>; Returns: {
              "contract_id": string,"event_date": string,"event_id": string,"event_title": string,"requirements_met": number,"requirements_total": number,"tenant_display_name": string,"tenant_slug": string
            }[]
                           },
"my_workspaces":
{ Args: Record<PropertyKey, never>; Returns: {
              "display_name": string,"role": string,"slug": string,"suspended": boolean
            }[]
                           },
"open_contract_template_draft":
{ Args: { "p_template_id": string }; Returns: string
                           },
"open_proposal_draft":
{ Args: { "p_event_id": string,"p_offer"?: Json }; Returns: string
                           },
"planning_library":
{ Args: Record<PropertyKey, never>; Returns: {
              "default_label": string,"description": string,"editor": string,"key": string,"kind": string,"library_order": number,"parent_keys": (string)[],"removable": boolean
            }[]
                           },
"platform_invitation_status":
{ Args: { "p_invitation_id": string }; Returns: Json
                           },
"platform_invitations_overview":
{ Args: Record<PropertyKey, never>; Returns: {
              "accepted_at": string,"created_at": string,"delivery_status": string,"email": string,"expires_at": string,"id": string,"last_sent_at": string,"revoked_at": string,"send_count": number,"state": string,"workspace_name": string,"workspace_slug": string
            }[]
                           },
"platform_workspaces_overview":
{ Args: Record<PropertyKey, never>; Returns: {
              "archived_at": string,"created_at": string,"display_name": string,"id": string,"is_member": boolean,"slug": string,"suspended_at": string,"suspended_by_email": string,"suspension_reason": string,"suspension_version": number
            }[]
                           },
"preview_proposal_offer":
{ Args: { "p_proposal_id": string }; Returns: Json
                           },
"proposal_offer_input_from_template":
{ Args: { "p_template_id": string }; Returns: Json
                           },
"public_tenant_brand":
{ Args: { "p_tenant_slug": string }; Returns: Json
                           },
"publish_contract_template_version":
{ Args: { "p_expected_draft_version": number,"p_version_id": string }; Returns: Json
                           } |
{ Args: { "p_client_use_statement_version"?: string,"p_expected_draft_version": number,"p_usage": string,"p_version_id": string }; Returns: Json
                           },
"recalculate_plan_client_cutoff":
{ Args: { "p_confirm": boolean,"p_event_id": string,"p_expected_version": number,"p_reason": string }; Returns: Json
                           },
"record_event_payment":
{ Args: { "p_amount_cents": number,"p_confirm_duplicate"?: boolean,"p_event_id": string,"p_idempotency_key": string,"p_note": string,"p_paid_on": string,"p_reference": string }; Returns: Json
                           },
"register_tenant_logo":
{ Args: { "p_byte_size": number,"p_height": number,"p_needs_dark_background": boolean,"p_sha256": string,"p_storage_path": string,"p_tenant_id": string,"p_user_id": string,"p_width": number }; Returns: string
                           },
"remove_planning_template_item":
{ Args: { "p_expected_version": number,"p_item_id": string }; Returns: number
                           },
"rename_event_plan_item":
{ Args: { "p_expected_version": number,"p_item_id": string,"p_label": string }; Returns: number
                           },
"rename_planning_template_item":
{ Args: { "p_expected_version": number,"p_item_id": string,"p_label": string }; Returns: number
                           },
"reopen_plan_client_editing":
{ Args: { "p_event_id": string,"p_expected_version": number,"p_reason": string,"p_until_local": string }; Returns: Json
                           },
"request_contract_sign_in":
{ Args: { "p_tenant_slug": string,"p_token_hash": string }; Returns: Json
                           },
"request_platform_sign_in":
{ Args: { "p_token_hash": string }; Returns: Json
                           },
"request_signed_contract_pdf":
{ Args: { "p_contract_id": string }; Returns: Json
                           },
"resend_contract":
{ Args: { "p_contract_id": string,"p_link_id": string,"p_token_hash": string }; Returns: Json
                           },
"resend_platform_invitation":
{ Args: { "p_invitation_id": string,"p_link_id": string,"p_token_hash": string }; Returns: Json
                           },
"restore_workspace":
{ Args: { "p_expected_version": number,"p_reason": string,"p_tenant_id": string }; Returns: Json
                           },
"retry_email_outbox":
{ Args: { "p_id": string }; Returns: boolean
                           },
"review_contract_for_send":
{ Args: { "p_contract_id": string }; Returns: Json
                           },
"revoke_platform_invitation":
{ Args: { "p_invitation_id": string }; Returns: Json
                           },
"save_contract_template_draft":
{ Args: { "p_expected_draft_version": number,"p_sections": Json,"p_title": string,"p_version_id": string }; Returns: number
                           },
"send_contract":
{ Args: { "p_contract_id": string,"p_link_id": string,"p_token_hash": string }; Returns: Json
                           },
"send_proposal":
{ Args: { "p_access_link_id": string,"p_expected_draft_version": number,"p_proposal_id": string,"p_token_hash": string }; Returns: Json
                           },
"send_signed_contract_copies":
{ Args: { "p_contract_id": string,"p_recipients": (string)[] }; Returns: Json
                           },
"set_client_archived":
{ Args: { "p_archived": boolean,"p_client_id": string }; Returns: Json
                           },
"set_event_archived":
{ Args: { "p_archived": boolean,"p_event_id": string }; Returns: Json
                           },
"set_event_invoice_url":
{ Args: { "p_event_id": string,"p_expected_version": number,"p_invoice_url": string }; Returns: number
                           },
"set_event_plan_item_enabled":
{ Args: { "p_enabled": boolean,"p_expected_version": number,"p_item_id": string }; Returns: number
                           },
"set_package_archived":
{ Args: { "p_archived": boolean,"p_package_id": string }; Returns: Json
                           },
"set_package_items":
{ Args: { "p_items": Json,"p_package_id": string }; Returns: undefined
                           },
"set_plan_client_cutoff":
{ Args: { "p_days": number,"p_event_id": string,"p_expected_version": number,"p_reason": string }; Returns: Json
                           },
"set_planning_template_archived":
{ Args: { "p_archived": boolean,"p_template_id": string }; Returns: number
                           },
"set_proposal_template_composition":
{ Args: { "p_addons": Json,"p_default_package_id": string,"p_package_ids": Json,"p_question_ids": Json,"p_template_id": string }; Returns: undefined
                           },
"setup_event_plan":
{ Args: { "p_event_id": string,"p_template_id": string }; Returns: Json
                           },
"sign_contract":
{ Args: { "p_client_ip": string,"p_client_ip_source": string,"p_consent_accepted": boolean,"p_consent_version": string,"p_content_sha256": string,"p_contract_id": string,"p_signature_bytes": number,"p_signature_height": number,"p_signature_path": string,"p_signature_sha256": string,"p_signature_width": number,"p_tenant_slug": string,"p_typed_name": string,"p_user_agent": string,"p_user_id": string }; Returns: Json
                           },
"staff_client_list":
{ Args: { "p_include_archived"?: boolean,"p_limit"?: number,"p_offset"?: number,"p_query"?: string,"p_tenant_id": string }; Returns: Json
                           },
"staff_dashboard":
{ Args: { "p_tenant_id": string,"p_upcoming_limit"?: number }; Returns: Json
                           },
"staff_event_list":
{ Args: { "p_include_archived"?: boolean,"p_limit"?: number,"p_offset"?: number,"p_query"?: string,"p_status"?: string,"p_tenant_id": string,"p_view"?: string }; Returns: Json
                           },
"staff_planning_view":
{ Args: { "p_event_id": string }; Returns: Json
                           },
"staff_save_plan_basics":
{ Args: { "p_answers": Json,"p_event_id": string,"p_expected_revision": number }; Returns: Json
                           },
"staff_save_plan_item":
{ Args: { "p_answers": Json,"p_event_id": string,"p_expected_revision": number,"p_item_id": string }; Returns: Json
                           },
"suspend_workspace":
{ Args: { "p_expected_version": number,"p_reason": string,"p_tenant_id": string }; Returns: Json
                           },
"tenant_logo_details":
{ Args: { "p_storage_path": string,"p_tenant_id": string }; Returns: Json
                           },
"update_booking_policy":
{ Args: { "p_expected_version": number,"p_policy": string,"p_tenant_id": string }; Returns: number
                           },
"update_business_settings":
{ Args: { "p_business_address": string,"p_contact_email": string,"p_deposit_percent": number,"p_legal_name": string,"p_tenant_id": string }; Returns: undefined
                           },
"update_planning_cutoff_days":
{ Args: { "p_days": number,"p_expected_version": number,"p_tenant_id": string }; Returns: number
                           },
"update_planning_template":
{ Args: { "p_default_event_type": string,"p_description": string,"p_expected_version": number,"p_name": string,"p_template_id": string }; Returns: number
                           },
"update_proposal_draft":
{ Args: { "p_expected_version": number,"p_offer": Json,"p_proposal_id": string }; Returns: number
                           },
"update_tax_settings":
{ Args: { "p_expected_version": number,"p_tax_categories": Json,"p_tax_config": Json,"p_tenant_id": string }; Returns: number
                           },
"update_tenant_branding":
{ Args: { "p_expected_version": number,"p_logo_id": string,"p_primary_color": string,"p_tenant_id": string }; Returns: number
                           },
"void_contract":
{ Args: { "p_contract_id": string,"p_reason": string }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const
