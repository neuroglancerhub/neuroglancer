import {PointAnnotation, AnnotationFacade} from 'neuroglancer/datasource/flyem/annotation';

export type DVIDPointAnnotation = PointAnnotation;

export type DVIDAnnotation = DVIDPointAnnotation;

export class DVIDAnnotationFacade extends AnnotationFacade {
  get renderingAttribute() {
    if (this.kind === 'Note') {
      if (this.checked) {
        return 1;
      }
      if (this.bookmarkType) {
        if (this.bookmarkType === 'False Split') {
          return 2;
        } else if (this.bookmarkType === 'False Merge') {
          return 3;
        }
      }
    } else if (this.kind === 'PreSyn') {
      return 4;
    } else if (this.kind === 'PostSyn') {
      return 5;
    }

    return 0;
  }
  get confidence() {
    if (this.kind === 'PreSyn' || this.kind === "PostSyn") {
        if (this.prop && this.prop.conf) {
            return parseFloat(this.prop.conf);
        }
    }
    return 0;
  }
}
