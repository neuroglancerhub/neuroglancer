/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
interface JsonArray extends Array<JsonValue> {}

export function isJsonArray(obj: JsonValue): obj is JsonArray {
  return Array.isArray(obj);
}

export function isJsonObject(obj: JsonValue): obj is JsonObject {
  if (isJsonArray(obj) || obj === null) {
    return false;
  } else {
    return typeof obj === "object";
  }
}

export class PropertyTreeNode {
  parentNode: PropertyTreeNode | null;
  childNodeList: Array<PropertyTreeNode> = new Array<PropertyTreeNode>();
  properties?: { [key: string]: any };
  record?: any;

  constructor(public name: string) {
    this.parentNode = null;
  }

  isRoot(): boolean {
    return this.parentNode === null;
  }

  isLeaf(): boolean {
    return this.childNodeList.length === 0;
  }

  *[Symbol.iterator](): Generator<PropertyTreeNode> {
    function* helper(node: PropertyTreeNode): Generator<PropertyTreeNode> {
      yield node;
      for (const child of node.childNodeList) {
        yield* helper(child);
      }
    }

    yield* helper(this);
  }

  *leafNodes(): Generator<PropertyTreeNode> {
    for (const node of this) {
      if (node.childNodeList.length === 0) {
        yield node;
      }
    }
  }

  get fullName(): string {
    let finalName = this.name;
    let pn = this.parentNode;
    while (pn) {
      finalName = pn.name + "/" + finalName;
      pn = pn.parentNode;
    }
    return finalName;
  }

  get nameArray(): Array<string> {
    const keyArray = new Array<string>();

    if (!this.isRoot()) {
      keyArray.push(this.name);
      let pn = this.parentNode;
      while (pn && !pn.isRoot()) {
        keyArray.push(pn.name);
        pn = pn.parentNode;
      }
    }

    return keyArray;
  }

  getPropertyValue(obj: JsonObject): any {
    if (!this.isRoot() && obj) {
      const keyArray = this.nameArray;

      let subobj: JsonValue | undefined = obj;

      for (let i = keyArray.length - 1; i >= 0; --i) {
        if (isJsonObject(subobj!)) {
          const key = keyArray[i];
          subobj = subobj![key];
        } else {
          return subobj;
        }
      }

      return subobj;
    }
  }
}

export function buildJsonSchemaTree(
  schema: JsonObject,
  currentNode: PropertyTreeNode,
) {
  if (schema.type == "object") {
    if (currentNode.properties == undefined) {
      currentNode.properties = {};
    }
    currentNode.properties["title"] = schema["title"];
    const required = schema.required;
    if (isJsonArray(required)) {
      required.forEach((prop: unknown) => {
        const propStr = prop as string;
        const node = new PropertyTreeNode(propStr);
        node.parentNode = currentNode;
        currentNode.childNodeList.push(node);
        const properties = schema["properties"] as JsonObject;
        const property = properties[propStr] as JsonObject;
        buildJsonSchemaTree(property, node);
      });
    }
  } else {
    currentNode.properties = schema;
  }
}

export function getJsonSchemaProperties(
  schema: JsonObject,
  rootName: string,
): PropertyTreeNode {
  const root = new PropertyTreeNode(rootName);
  buildJsonSchemaTree(schema, root);

  return root;
}
