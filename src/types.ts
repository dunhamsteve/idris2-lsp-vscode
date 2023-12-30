export interface Premise {
  /**
   * The location of this premise.
   */
  location: Position | null;
  /**
   * The name of this premise.
   */
  name: string;
  /**
   * The type of this premise.
   */
  type: string;
  /**
   * A flag which indicates whether the premise is an implicit argument.
   */
  isImplicit: boolean;
  /**
   * multiplicity
   */
  multiplicity: string;
}

export interface Metavar {
  /**
   * The location of this metavariable.
   */
  location: {
    range: Range;
    uri: string;
  };
  /**
   * Name of this metavariable.
   */
  name: string;
  /**
   * The type of this metavariable.
   */
  type: string;
  /**
   * The list of premises of this metavariable.
   */
  premises: Premise[];
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface SelectMessage {
  uri: string;
  range: Range;
}

export type Message = { select: SelectMessage };

export interface Diagnostic {
  severity: string;
  message: string;
  range: [Position, Position];
  source: string;
}

export interface Signature {
  label: string;
  documentation: string;
}
