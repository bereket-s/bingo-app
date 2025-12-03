import React from "react";

function BingoCard({ cardData, markedCells = new Set(), onCellClick, isPreview = false }) {
  return (
    <div className={`bingo-card ${isPreview ? 'preview' : ''}`}>
      <div className="bingo-header">
        <span>B</span><span>I</span><span>N</span><span>G</span><span>O</span>
      </div>
      <div className="bingo-grid">
        {[0,1,2,3,4].map(rowIndex => (
             [0,1,2,3,4].map(colIndex => {
                 const cellVal = cardData[rowIndex][colIndex];
                 const isFree = cellVal === 'FREE';
                 const valStr = String(cellVal);
                 
                 let className = "bingo-cell";
                 if (isFree) className += " free-space";
                 if (!isPreview && markedCells.has(valStr)) className += " marked";

                 return (
                    <div 
                      key={`${rowIndex}-${colIndex}`} 
                      className={className}
                      onClick={() => !isPreview && !isFree && onCellClick && onCellClick(cellVal)}
                    >
                      {cellVal}
                    </div>
                 );
             })
        ))}
      </div>
    </div>
  );
}

export default BingoCard;