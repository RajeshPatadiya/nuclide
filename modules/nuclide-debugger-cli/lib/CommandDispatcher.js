/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow strict
 * @format
 */

import type {Command} from './Command';
import type {DispatcherInterface} from './DispatcherInterface';

export default class CommandDispatcher implements DispatcherInterface {
  _commands: Command[] = [];
  _aliases: Map<string, string>;

  constructor(aliases: Map<string, string>) {
    this._aliases = aliases;
  }

  registerCommand(command: Command): void {
    this._commands.push(command);
  }

  getCommands(): Command[] {
    return this._commands;
  }

  getCommandsMatching(prefix: string): Command[] {
    const re = new RegExp(`^${prefix}`);
    return this._commands.filter(x => x.name.match(re));
  }

  commandListToString(commands: Command[]): string {
    const names = commands.map(_ => _.name);
    return `"${names.join('", "')}"`;
  }

  async execute(line: string): Promise<?Error> {
    let tail = line;
    const tokens: string[] = [];

    // Here we're looking for quoted arguments.
    // \1 is the contents of a single-quoted arg that may contain spaces
    // \2 is a space-delimited arg if there are no quotes
    // \3 is the rest of the command line
    const tokenizer: RegExp = /^\s*(?:('([^']*)')|(\S+))\s*(.*)$/;

    while (tail.length > 0) {
      const match = tail.match(tokenizer);
      if (match == null) {
        break;
      }

      const [, , quoted, unquoted, rest] = match;
      tokens.push(quoted != null ? quoted : unquoted);
      tail = rest;
    }

    return this.executeTokenizedLine(tokens);
  }

  async executeTokenizedLine(tokens: string[]): Promise<?Error> {
    if (tokens.length === 0 || !tokens[0]) {
      return;
    }

    // Get all commands of which the given command is a prefix
    const cmd = tokens[0];

    // resolve aliases
    const alias = this.resolveAlias(tokens);
    if (alias != null) {
      return this.execute(alias);
    }

    const matches = this.getCommandsMatching(cmd);

    if (matches.length === 0) {
      return new Error(`No command matches "${cmd}".`);
    }

    if (matches.length > 1) {
      const list = this.commandListToString(matches);
      return new Error(`Multiple commands match "${cmd}": ${list}`);
    }

    return new Promise((resolve, reject) => {
      matches[0]
        .execute(tokens.slice(1))
        .then(_ => resolve(null), _ => resolve(_));
    });
  }

  resolveAlias(tokens: string[]): ?string {
    const alias = this._aliases.get(tokens[0]);
    if (alias != null) {
      return `${alias} ${tokens.splice(1).join(' ')}`;
    }

    const match = tokens[0].match(/^([^a-zA-Z0-9]+)(.*)$/);
    if (match != null) {
      const [, prefix, tail] = match;
      const puncAlias = this._aliases.get(prefix);
      if (puncAlias != null) {
        return `${puncAlias} ${tail} ${tokens.splice(1).join(' ')}`;
      }
    }

    return null;
  }
}
