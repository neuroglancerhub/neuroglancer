type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = {[key: string]: JsonValue};
interface JsonArray extends Array<JsonValue>{};

export function isJsonArray(obj: JsonValue): obj is JsonArray
{
  return Array.isArray(obj);
}

export function isJsonObject(obj: JsonValue): obj is JsonObject
{
  if (isJsonArray(obj) || obj === null) {
    return false;
  } else {
    return typeof(obj) === 'object';
  }
}

export class PropertyTreeNode {
  parentNode: PropertyTreeNode|null;
  childNodeList: Array<PropertyTreeNode> = new Array<PropertyTreeNode>();
  properties?: {[key: string]: any};
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

  *[Symbol.iterator]() {
    function *helper(node:PropertyTreeNode) : any{
      yield node;
      for (let child of node.childNodeList) {
        yield *helper(child);
      }
    }

    yield *helper(this);
  }

  * leafNodes() {
    for (let node of this) {
      if (node.childNodeList.length === 0) {
        yield node;
      }
    }
  }

  get fullName():string {
    let finalName = this.name;
    let pn = this.parentNode;
    while (pn) {
      finalName = pn.name + "/" + finalName;
      pn = pn.parentNode;
    }
    return finalName;
  }

  get nameArray(): Array<string> {
    let keyArray = new Array<string>();

    if (!this.isRoot()) {
      keyArray.push(this.name);
      let pn = this.parentNode;
      while (pn && !pn.isRoot()) {
        // console.log(pn);
        keyArray.push(pn.name);
        pn = pn.parentNode;
      }
    }

    return keyArray;
  }

  getPropertyValue(obj: JsonObject): any {
    if (!this.isRoot() && obj) {
      
      let keyArray = this.nameArray;

      // console.log('input object:', obj);
      let subobj:JsonValue|undefined = obj;

      for (let i = keyArray.length - 1; i >= 0; --i) {
        if (isJsonObject(subobj!)) {
          let key = keyArray[i];
          subobj = subobj![key];
        } else {
          return subobj;
        }
      }

      return subobj;
    }
  }
}

export function buildJsonSchemaTree(schema: JsonObject, currentNode: PropertyTreeNode)
{
  // console.log(schema);
  if (schema.type == 'object') {
    if (currentNode.properties == undefined) {
      currentNode.properties = {};
    }
    currentNode.properties['title'] = schema['title'];
    let required = schema.required;
    if (isJsonArray(required)) {
      required.forEach(
        (prop:string) => {
          let node = new PropertyTreeNode(prop);
          node.parentNode = currentNode;
          currentNode.childNodeList.push(node);
          let properties = schema['properties'] as JsonObject;
          let property = properties[prop] as JsonObject;
          buildJsonSchemaTree(property, node);
        }
      );
    }
  } else {
    currentNode.properties = schema;
  }
}

export function getJsonSchemaProperties(schema: JsonObject, rootName: string): PropertyTreeNode
{
  let root = new PropertyTreeNode(rootName);
  buildJsonSchemaTree(schema, root);

  return root;
}