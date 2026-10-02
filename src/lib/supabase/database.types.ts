
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
                    "archived_at": string | null,"booking_confirmation_policy": string,"brand_colors": NonNullable<Json>,"business_name": string,"created_at": string,"currency": string,"display_name": string,"id": string,"logo_storage_path": string | null,"planning_lock_days": number,"reply_to_email": string | null,"slug": string,"tax_config": NonNullable<Json>,"timezone": string,"updated_at": string
                  }
                  Insert: {
                    "archived_at"?: string | null,"booking_confirmation_policy"?: string,"brand_colors"?: NonNullable<Json>,"business_name": string,"created_at"?: string,"currency"?: string,"display_name": string,"id"?: string,"logo_storage_path"?: string | null,"planning_lock_days"?: number,"reply_to_email"?: string | null,"slug": string,"tax_config"?: NonNullable<Json>,"timezone"?: string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"booking_confirmation_policy"?: string,"brand_colors"?: NonNullable<Json>,"business_name"?: string,"created_at"?: string,"currency"?: string,"display_name"?: string,"id"?: string,"logo_storage_path"?: string | null,"planning_lock_days"?: number,"reply_to_email"?: string | null,"slug"?: string,"tax_config"?: NonNullable<Json>,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "my_events":
{ Args: Record<PropertyKey, never>; Returns: {
              "event_date": string,"event_id": string,"event_type": string,"lifecycle_status": string,"tenant_display_name": string,"tenant_slug": string,"timezone": string,"title": string,"venue_address": string,"venue_name": string
            }[]
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
