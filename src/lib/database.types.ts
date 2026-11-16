// GEGENEREERD BESTAND, niet met de hand aanpassen.
// Opnieuw genereren na een migratie: `pnpm db:types` (met `pnpm db:start` actief).
// De CI controleert of dit bestand nog gelijkloopt met het databaseschema.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: { extensions?: Json; operationName?: string; query?: string; variables?: Json };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      bestellingen: {
        Row: {
          geplaatst_op: string;
          id: string;
          klant_id: string;
          sleutel: string;
          totaal_centen: number;
        };
        ComputedFields: never;
        Insert: {
          geplaatst_op?: string;
          id?: string;
          klant_id: string;
          sleutel: string;
          totaal_centen: number;
        };
        Update: {
          geplaatst_op?: string;
          id?: string;
          klant_id?: string;
          sleutel?: string;
          totaal_centen?: number;
        };
        Relationships: [];
      };
      bestelregels: {
        Row: {
          aantal: number;
          bestelling_id: string;
          id: string;
          naam: string;
          product_id: string | null;
          stukprijs_centen: number;
        };
        ComputedFields: never;
        Insert: {
          aantal: number;
          bestelling_id: string;
          id?: string;
          naam: string;
          product_id?: string | null;
          stukprijs_centen: number;
        };
        Update: {
          aantal?: number;
          bestelling_id?: string;
          id?: string;
          naam?: string;
          product_id?: string | null;
          stukprijs_centen?: number;
        };
        Relationships: [
          {
            foreignKeyName: "bestelregels_bestelling_id_fkey";
            columns: ["bestelling_id"];
            isOneToOne: false;
            referencedRelation: "bestellingen";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bestelregels_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "producten";
            referencedColumns: ["id"];
          },
        ];
      };
      klant_afwijzingen: {
        Row: {
          afgewezen_op: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          afgewezen_op?: string;
          user_id: string;
        };
        Update: {
          afgewezen_op?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "klant_afwijzingen_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "klanten";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "klant_afwijzingen_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "klanten_overzicht";
            referencedColumns: ["user_id"];
          },
        ];
      };
      klanten: {
        Row: {
          aangemeld_op: string;
          e_mail: string;
          goedgekeurd: boolean;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          aangemeld_op?: string;
          e_mail: string;
          goedgekeurd?: boolean;
          user_id: string;
        };
        Update: {
          aangemeld_op?: string;
          e_mail?: string;
          goedgekeurd?: boolean;
          user_id?: string;
        };
        Relationships: [];
      };
      klantprijzen: {
        Row: {
          id: string;
          klant_id: string;
          prijs_centen: number;
          product_id: string;
        };
        ComputedFields: never;
        Insert: {
          id?: string;
          klant_id: string;
          prijs_centen: number;
          product_id: string;
        };
        Update: {
          id?: string;
          klant_id?: string;
          prijs_centen?: number;
          product_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "klantprijzen_klant_id_fkey";
            columns: ["klant_id"];
            isOneToOne: false;
            referencedRelation: "klanten";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "klantprijzen_klant_id_fkey";
            columns: ["klant_id"];
            isOneToOne: false;
            referencedRelation: "klanten_overzicht";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "klantprijzen_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "producten";
            referencedColumns: ["id"];
          },
        ];
      };
      producten: {
        Row: {
          afbeelding: string | null;
          basisprijs_centen: number;
          bijgewerkt_op: string;
          id: string;
          naam: string;
          omschrijving: string;
          slug: string;
          voorraad: number;
          zichtbaar: boolean;
        };
        ComputedFields: never;
        Insert: {
          afbeelding?: string | null;
          basisprijs_centen: number;
          bijgewerkt_op?: string;
          id?: string;
          naam: string;
          omschrijving?: string;
          slug: string;
          voorraad?: number;
          zichtbaar?: boolean;
        };
        Update: {
          afbeelding?: string | null;
          basisprijs_centen?: number;
          bijgewerkt_op?: string;
          id?: string;
          naam?: string;
          omschrijving?: string;
          slug?: string;
          voorraad?: number;
          zichtbaar?: boolean;
        };
        Relationships: [];
      };
      winkelwagen_regels: {
        Row: {
          aantal: number;
          id: string;
          klant_id: string;
          product_id: string;
        };
        ComputedFields: never;
        Insert: {
          aantal: number;
          id?: string;
          klant_id?: string;
          product_id: string;
        };
        Update: {
          aantal?: number;
          id?: string;
          klant_id?: string;
          product_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "winkelwagen_regels_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "producten";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      klanten_overzicht: {
        Row: {
          aangemeld_op: string | null;
          afgewezen: boolean | null;
          e_mail: string | null;
          goedgekeurd: boolean | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      wagen_overzicht: {
        Row: {
          aantal: number | null;
          afbeelding: string | null;
          genoeg_voorraad: boolean | null;
          id: string | null;
          naam: string | null;
          product_id: string | null;
          slug: string | null;
          stukprijs_centen: number | null;
          te_koop: boolean | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "winkelwagen_regels_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "producten";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      bestelling_plaatsen: {
        Args: { p_sleutel: string; p_verwacht_totaal: number };
        Returns: string;
      };
      is_goedgekeurde_klant: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_medewerker: { Args: Record<PropertyKey, never>; Returns: boolean };
      klant_aanmelden: { Args: Record<PropertyKey, never>; Returns: undefined };
      klant_beoordelen: { Args: { p_doe: string; p_klant: string }; Returns: undefined };
      openbare_producten: {
        Args: { p_slug?: string };
        Returns: {
          afbeelding: string;
          basisprijs_centen: number;
          bijgewerkt_op: string;
          id: string;
          naam: string;
          omschrijving: string;
          op_voorraad: boolean;
          slug: string;
        }[];
      };
      product_te_koop: { Args: { p_product_id: string }; Returns: boolean };
      sessie_via_cloudflare: { Args: Record<PropertyKey, never>; Returns: boolean };
      wagen_toevoegen: { Args: { p_aantal?: number; p_product_id: string }; Returns: number };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
