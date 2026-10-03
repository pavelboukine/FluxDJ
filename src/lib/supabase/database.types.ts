
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "clients": {
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
                },"events": {
                  Row: {
                    "booking_confirmed_at": string | null,"created_at": string,"event_date": string,"event_type": string,"id": string,"internal_notes": string | null,"lifecycle_status": string,"planning_lock_at": string | null,"planning_override_until": string | null,"tenant_id": string,"timezone": string,"title": string,"updated_at": string,"venue_address": string | null,"venue_name": string | null
                  }
                  Insert: {
                    "booking_confirmed_at"?: string | null,"created_at"?: string,"event_date": string,"event_type": string,"id"?: string,"internal_notes"?: string | null,"lifecycle_status"?: string,"planning_lock_at"?: string | null,"planning_override_until"?: string | null,"tenant_id": string,"timezone"?: string,"title": string,"updated_at"?: string,"venue_address"?: string | null,"venue_name"?: string | null
                  }
                  Update: {
                    "booking_confirmed_at"?: string | null,"created_at"?: string,"event_date"?: string,"event_type"?: string,"id"?: string,"internal_notes"?: string | null,"lifecycle_status"?: string,"planning_lock_at"?: string | null,"planning_override_until"?: string | null,"tenant_id"?: string,"timezone"?: string,"title"?: string,"updated_at"?: string,"venue_address"?: string | null,"venue_name"?: string | null
                  }
                  Relationships: [
                    {
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
                    "addon_quantities": NonNullable<Json>,"created_at": string,"currency": string,"id": string,"logistics_answers": NonNullable<Json>,"offer_sha256": string,"package_key": string,"pricing_version": string,"proposal_id": string,"selection_snapshot": NonNullable<Json>,"submitted_at": string | null,"subtotal_cents": number,"tax_breakdown": NonNullable<Json>,"tax_cents": number,"tenant_id": string,"total_cents": number,"updated_at": string,"version": number
                  }
                  Insert: {
                    "addon_quantities": NonNullable<Json>,"created_at"?: string,"currency": string,"id"?: string,"logistics_answers": NonNullable<Json>,"offer_sha256": string,"package_key": string,"pricing_version": string,"proposal_id": string,"selection_snapshot": NonNullable<Json>,"submitted_at"?: string | null,"subtotal_cents": number,"tax_breakdown": NonNullable<Json>,"tax_cents": number,"tenant_id": string,"total_cents": number,"updated_at"?: string,"version": number
                  }
                  Update: {
                    "addon_quantities"?: NonNullable<Json>,"created_at"?: string,"currency"?: string,"id"?: string,"logistics_answers"?: NonNullable<Json>,"offer_sha256"?: string,"package_key"?: string,"pricing_version"?: string,"proposal_id"?: string,"selection_snapshot"?: NonNullable<Json>,"submitted_at"?: string | null,"subtotal_cents"?: number,"tax_breakdown"?: NonNullable<Json>,"tax_cents"?: number,"tenant_id"?: string,"total_cents"?: number,"updated_at"?: string,"version"?: number
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
                    "archived_at": string | null,"booking_confirmation_policy": string,"brand_colors": NonNullable<Json>,"business_name": string,"created_at": string,"currency": string,"display_name": string,"id": string,"logo_storage_path": string | null,"planning_lock_days": number,"reply_to_email": string | null,"slug": string,"tax_categories": NonNullable<Json>,"tax_config": NonNullable<Json>,"timezone": string,"updated_at": string
                  }
                  Insert: {
                    "archived_at"?: string | null,"booking_confirmation_policy"?: string,"brand_colors"?: NonNullable<Json>,"business_name": string,"created_at"?: string,"currency"?: string,"display_name": string,"id"?: string,"logo_storage_path"?: string | null,"planning_lock_days"?: number,"reply_to_email"?: string | null,"slug": string,"tax_categories"?: NonNullable<Json>,"tax_config"?: NonNullable<Json>,"timezone"?: string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"booking_confirmation_policy"?: string,"brand_colors"?: NonNullable<Json>,"business_name"?: string,"created_at"?: string,"currency"?: string,"display_name"?: string,"id"?: string,"logo_storage_path"?: string | null,"planning_lock_days"?: number,"reply_to_email"?: string | null,"slug"?: string,"tax_categories"?: NonNullable<Json>,"tax_config"?: NonNullable<Json>,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "freeze_proposal_offer":
{ Args: { "p_proposal_id": string }; Returns: string
                           },
"my_events":
{ Args: Record<PropertyKey, never>; Returns: {
              "event_date": string,"event_id": string,"event_type": string,"lifecycle_status": string,"tenant_display_name": string,"tenant_slug": string,"timezone": string,"title": string,"venue_address": string,"venue_name": string
            }[]
                           },
"open_proposal_draft":
{ Args: { "p_event_id": string,"p_offer"?: Json }; Returns: string
                           },
"preview_proposal_offer":
{ Args: { "p_proposal_id": string }; Returns: Json
                           },
"proposal_offer_input_from_template":
{ Args: { "p_template_id": string }; Returns: Json
                           },
"record_proposal_selection":
{ Args: { "p_expected_version": number,"p_proposal_id": string,"p_selection": Json }; Returns: string
                           },
"save_proposal_selection_draft":
{ Args: { "p_addon_quantities": Json,"p_expected_version": number,"p_logistics_answers": Json,"p_package_key": string,"p_proposal_id": string }; Returns: number
                           },
"set_package_items":
{ Args: { "p_items": Json,"p_package_id": string }; Returns: undefined
                           },
"set_proposal_template_composition":
{ Args: { "p_addons": Json,"p_default_package_id": string,"p_package_ids": Json,"p_question_ids": Json,"p_template_id": string }; Returns: undefined
                           },
"update_proposal_draft":
{ Args: { "p_expected_version": number,"p_offer": Json,"p_proposal_id": string }; Returns: number
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
